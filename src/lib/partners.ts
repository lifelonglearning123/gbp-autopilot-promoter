import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, creators, messages, samples } from "@/db/schema";
import { env } from "@/env";
import { agencyKey, emailType, tidyEmail } from "./contact-rules";
import { themeColour } from "./crawl-rules";
import { hostOf } from "./creator-rules";
import { writerFor } from "./draft";
import { partnerProblems, sameBusiness, type PartnerEmails } from "./draft-rules";
import { askJson } from "./openrouter";
import { PARTNER_FACTS } from "./offer";
import { claimLink, makeSample, PlatformError, shortClaimUrl, type Sample } from "./platform";
import { isTikTok, readTikTok } from "./creators";
import { channels } from "./youtube";

/**
 * The creator offer, for every YouTube or TikTok creator we qualify (agency, educator,
 * or a channel for local business owners): their own white-label GBP
 * Autopilot in their brand, at no cost, and 40% for life of what the
 * businesses on it pay.
 *   hand over  a creator with a public email becomes a contact (source
 *              "partner:<channel>") on an agency row in status "partner", so
 *              research and the agency drafts never touch it. YouTube agencies
 *              handed to the reseller pipeline earlier, whose email was not yet
 *              pushed, move over too.
 *   draft      a sample audit of their own listing in their brand (avatar as
 *              logo) when Google has one, else a claim link alone — both made
 *              as offer "creator" so the claimed account is a creator's. Then
 *              the first email and three follow-ups, checked (rules, then the
 *              analysis model), one rewrite, held HOLD_HOURS; the agency row goes
 *              to "queued" so the push picks it up for the partners' campaign.
 */

type Log = (line: string) => void;

export async function handOverPartners(limit: number, log: Log) {
  const tally: Record<string, number> = {};

  // Earlier YouTube agencies whose reseller email has not gone: the creator offer instead.
  const moved = (await db().execute(sql`
    select cr.id creator_id, cr.channel_id, c.id contact_id, c.agency_id
    from creators cr join contacts c on c.agency_id = cr.agency_id and c.source like 'youtube:%'
    where cr.status = 'in_pipeline'
      and not exists (select 1 from messages m where m.contact_id = c.id and m.pushed_at is not null)
    limit ${limit}`)) as unknown as { creator_id: string; channel_id: string; contact_id: string; agency_id: string }[];
  for (const m of moved) {
    await db().update(messages).set({ stoppedAt: new Date() }).where(and(eq(messages.contactId, m.contact_id), isNull(messages.pushedAt)));
    await db().update(contacts).set({ source: `partner:${m.channel_id}`, updatedAt: new Date() }).where(eq(contacts.id, m.contact_id));
    await db().update(agencies).set({ status: "partner", updatedAt: new Date() }).where(eq(agencies.id, m.agency_id));
    await db().update(creators).set({ status: "partner_pipeline", updatedAt: new Date() }).where(eq(creators.id, m.creator_id));
    tally.moved_from_reseller = (tally.moved_from_reseller ?? 0) + 1;
  }

  const todo = (await db().execute(sql`
    select id from creators
    where status in ('qualified', 'enriched', 'educator', 'audience') and agency_id is null and links <> '{}'::jsonb
    order by updated_at limit ${limit}`)) as unknown as { id: string }[];
  for (const { id } of todo) {
    const [c] = await db().select().from(creators).where(eq(creators.id, id)).limit(1);
    const site = c.links.website ?? null;
    const siteHost = site ? hostOf(site) : null;
    const pick =
      c.emails.find((e) => siteHost && e.email.endsWith(`@${siteHost}`)) ?? c.emails.find((e) => emailType(e.email) === "work") ?? c.emails[0];
    const email = tidyEmail(pick?.email);
    let status = "partner_no_email";
    let agencyId: string | null = null;
    if (email) {
      const made = await db()
        .insert(agencies)
        .values({ name: c.title, domain: agencyKey(site, email), website: site, country: c.country, status: "partner", fitScore: c.fitScore })
        .onConflictDoNothing({ target: agencies.domain })
        .returning({ id: agencies.id });
      if (made.length) {
        agencyId = made[0].id;
        await db()
          .insert(contacts)
          .values({
            agencyId,
            email,
            emailType: emailType(email),
            phone: c.phones[0]?.phone ?? null,
            country: c.country,
            source: `partner:${c.channelId}`,
            sourceProof: { url: pick.source, seenAt: new Date().toISOString() },
          })
          .onConflictDoNothing();
        status = "partner_pipeline";
      } else {
        // Already in our agency list: it gets the agency emails, not a second pitch.
        status = "partner_known";
      }
    }
    await db().update(creators).set({ status, agencyId, updatedAt: new Date() }).where(eq(creators.id, id));
    tally[status] = (tally[status] ?? 0) + 1;
  }
  if (moved.length || todo.length) log(`creators handed over: ${JSON.stringify(tally)}`);
}

const WRITER = `You write a cold email sequence from Chao, founder of GBP Autopilot, to a YouTube or TikTok creator (which one is given below), offering them their own white-label GBP Autopilot.
${PARTNER_FACTS}

Return ONLY a JSON object: {"subject": string, "body": string, "body_2": string, "body_3": string, "body_4": string}.
- subject: under 50 characters, lower-key, no exclamation marks, no capitals for emphasis; hint at their own branded version.
- body (first email, day 0): 80-130 words, plain text, UK English, short paragraphs. Greet by first name if given, else "Hi there". Open with one of their recent videos, by its topic, naturally (not "I watched your video", no flattery), and why their audience fits. Then the offer, plainly: their own white-label Google Business Profile service under their brand, at no cost to them; businesses from their audience sign up on it at £49 a month and they earn 40% of what each pays, for life; we do all the work. If an audit is given, one concrete finding from it as proof, with the audit link once. The CLAIM LINK written out exactly once on its own line, to set up their branded version. One soft question.
- body_2 (day 3, a reply in the same thread): 35-70 words. One different angle (e.g. how they would show it to their audience, or another finding from the audit). Short question. No link needed.
- body_3 (day 7): 50-100 words. The numbers, plainly: £49 a month per business, so about £19.60 a month to them for every business that stays, for life; nothing to pay; the CLAIM LINK once on its own line. Soft question.
- body_4 (day 14): 25-55 words. A short, friendly last note: you'll stop writing; the offer stands if they reply later.
- No sign-off or name (added later). The only links allowed are the claim link and the audit link given. No placeholders, no hype (game-changer, skyrocket, passive income machine), no flattery, no invented numbers, results or terms.`;

const CHECKER = `You check a cold email sequence to a YouTube or TikTok creator before it is sent, against the facts, the channel details and the audit given.
True facts, which the emails may state:
${PARTNER_FACTS}
Return ONLY a JSON object: {"ok": boolean, "notes": string[]}.
ok is false if the first email does not make the offer plain (their own white-label GBP Autopilot in their brand, at no cost, 40% of what the businesses pay, for life); any email states terms or facts not given (payout schedule, bonuses, results), misreads the audit, misdescribes their channel, is pushy, guilt-tripping, flattering or hype-y, reads as a template, or would embarrass the sender. notes: short, specific fixes (empty when ok).`;

/** Each creator can take minutes (a sample audit, writing, checking): stops while the run still has time to finish. */
export async function draftPartners(limit: number, log: Log, deadline = Infinity) {
  const todo = (await db().execute(sql`
    select c.id from contacts c join agencies a on a.id = c.agency_id
    where c.source like 'partner:%' and c.email_status = 'valid' and a.status = 'partner'
      and not exists (select 1 from messages m where m.contact_id = c.id and m.stopped_at is null)
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    limit ${limit}`)) as unknown as { id: string }[];
  const tally: Record<string, number> = {};
  for (const { id } of todo) {
    if (deadline - Date.now() < 240_000) break;
    const r = await draftPartner(id).catch((e: unknown) => ({ why: e instanceof Error ? e.message : String(e) }));
    const k = "why" in r ? `failed (${r.why.slice(0, 80)})` : r.passed ? "queued" : "needs_review";
    tally[k] = (tally[k] ?? 0) + 1;
  }
  if (todo.length) log(`creator emails: ${JSON.stringify(tally)}`);
}

/** Their brand: the channel's or account's profile picture as logo, their site's theme colour if they have a site. */
async function brandOf(c: typeof creators.$inferSelect) {
  const avatar = isTikTok(c.channelId)
    ? ((await readTikTok(c.channelId.slice("tiktok:".length)).catch(() => null))?.avatar ?? null)
    : env.YOUTUBE_API_KEY
      ? ((await channels([c.channelId]).catch(() => []))[0]?.avatar ?? null)
      : null;
  let colour: string | null = null;
  if (c.links.website) {
    const res = await fetch(c.links.website, { redirect: "follow", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (res?.ok) colour = themeColour((await res.text()).slice(0, 500_000));
  }
  return { name: c.title, logoUrl: avatar, colour };
}

async function draftPartner(contactId: string): Promise<{ passed: boolean }> {
  const [row] = await db()
    .select({ contact: contacts, creator: creators })
    .from(contacts)
    .innerJoin(creators, eq(creators.agencyId, contacts.agencyId))
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!row) throw new Error("no creator for this contact");
  const { contact, creator: c } = row;
  const brand = await brandOf(c);
  if (brand.logoUrl || brand.colour) {
    await db().update(agencies).set({ branding: { logoUrl: brand.logoUrl, colour: brand.colour } }).where(eq(agencies.id, contact.agencyId));
  }

  // A sample of their own listing if Google has one; a claim link alone otherwise.
  let sample: Sample | null = null;
  try {
    const s = await makeSample({ name: c.title, town: c.country ?? "", brand, externalRef: contact.id, contact: { email: contact.email }, offer: "creator" });
    if (sameBusiness(c.title, s.result.title)) sample = s;
  } catch (e) {
    const status = e instanceof PlatformError ? e.status : 0;
    if (!(status >= 400 && status < 500 && ![401, 403, 429].includes(status))) throw e;
  }
  let claimUrl: string;
  let previewUrl: string | null = null;
  if (sample?.claimUrl) {
    await db()
      .insert(samples)
      .values({
        agencyId: contact.agencyId,
        contactId: contact.id,
        kind: "own",
        platformToken: sample.token,
        previewUrl: sample.previewUrl,
        claimUrl: sample.claimUrl,
        score: sample.result.score,
        result: sample.result as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing();
    claimUrl = shortClaimUrl({ claimUrl: sample.claimUrl, platformToken: sample.token })!;
    previewUrl = sample.previewUrl;
  } else {
    sample = null;
    ({ claimUrl } = await claimLink({ agencyName: c.title, email: contact.email, logoUrl: brand.logoUrl, colour: brand.colour, externalRef: contact.id, offer: "creator" }));
  }

  const writer = contact.writerModel ?? writerFor(contact.id);
  if (writer !== contact.writerModel) await db().update(contacts).set({ writerModel: writer, updatedAt: new Date() }).where(eq(contacts.id, contact.id));
  const r = sample?.result;
  const brief = [
    `First name: ${contact.firstName?.trim() || "(unknown)"}`,
    isTikTok(c.channelId)
      ? `TikTok account: "${c.title}" (${c.handle}, ${c.subscribers ?? "?"} followers, country ${c.country ?? "?"})`
      : `YouTube channel: "${c.title}" (${c.subscribers ?? "?"} subscribers, country ${c.country ?? "?"})`,
    `Who watches them: ${c.kind === "audience" ? "local business owners" : c.kind === "educator" ? "marketers and agencies (they teach marketing)" : "local businesses and marketers (they run an agency or sell local SEO)"}`,
    `About them: ${c.qualifyNotes ?? ""}`,
    `Recent videos:`,
    ...c.recentVideos.slice(0, 5).map((v) => `- "${v.title}"${v.publishedAt ? ` (${v.publishedAt.slice(0, 10)})` : ""}`),
    ``,
    r
      ? [
          `The audit (of their own Google listing "${r.title}", ${r.address}, already in their brand): score ${r.score}/100. Verdict: ${r.verdict}`,
          ...(r.gaps ?? []).slice(0, 4).map((g) => `- ${g.label}: ${g.note}`),
          `Audit link: ${previewUrl}`,
        ].join("\n")
      : `No audit (they have no Google listing of their own): do not mention an audit.`,
    `Claim link (sets up their branded version): ${claimUrl}`,
  ].join("\n");

  let draft: PartnerEmails = { subject: "", body: "", body_2: "", body_3: "", body_4: "" };
  let notes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const fix = attempt > 0 ? `\n\nYour previous draft:\n${JSON.stringify(draft)}\nFix these problems:\n- ${notes.join("\n- ")}` : "";
    const { data } = await askJson<PartnerEmails>({ model: writer, system: WRITER, user: brief + fix, maxTokens: 1500 });
    draft = {
      subject: String(data.subject ?? "").trim(),
      body: String(data.body ?? "").trim(),
      body_2: String(data.body_2 ?? "").trim(),
      body_3: String(data.body_3 ?? "").trim(),
      body_4: String(data.body_4 ?? "").trim(),
    };
    notes = partnerProblems(draft, { claimUrl, previewUrl });
    if (notes.length === 0) {
      const { data: check } = await askJson<{ ok: boolean; notes: string[] }>({
        model: env.ANALYSIS_MODEL,
        system: CHECKER,
        user: `${brief}\n\nThe emails:\n${JSON.stringify(draft, null, 1)}`,
        maxTokens: 600,
      });
      notes = check.ok ? [] : (check.notes ?? ["checker said no, without notes"]);
    }
    if (notes.length === 0) break;
  }

  const passed = notes.length === 0;
  await db().delete(messages).where(and(eq(messages.contactId, contactId), gte(messages.step, 1), lte(messages.step, 4), isNull(messages.pushedAt)));
  await db()
    .insert(messages)
    .values([
      {
        contactId,
        writerModel: writer,
        step: 1,
        subject: draft.subject,
        body: draft.body,
        guardrail: { ok: passed, notes },
        holdUntil: new Date(Date.now() + env.HOLD_HOURS * 3_600_000),
      },
      ...([2, 3, 4] as const).map((step) => ({
        contactId,
        writerModel: writer,
        step,
        subject: null,
        body: draft[`body_${step}` as const],
        guardrail: { ok: passed, notes: [] },
      })),
    ]);
  await db()
    .update(agencies)
    .set({ status: passed ? "queued" : "needs_review", updatedAt: new Date() })
    .where(and(eq(agencies.id, contact.agencyId), inArray(agencies.status, ["partner", "needs_review"])));
  return { passed };
}
