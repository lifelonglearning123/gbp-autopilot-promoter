import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, creators, messages } from "@/db/schema";
import { env } from "@/env";
import { agencyKey, emailType, tidyEmail } from "./contact-rules";
import { hostOf } from "./creator-rules";
import { writerFor } from "./draft";
import { partnerProblems, type PartnerEmails } from "./draft-rules";
import { askJson } from "./openrouter";
import { PARTNER_FACTS, PARTNER_URL } from "./offer";

/**
 * Creator partners: educators (teach agencies) and channels whose audience is
 * local business owners, offered 40% for life for promoting local.macaws.ai.
 *   hand over  a partner with a public email becomes a contact (source
 *              "partner:<channel>") on an agency row in status "partner", so
 *              research and the agency drafts never touch it
 *   draft      the first email and three follow-ups at once, checked (rules,
 *              then the analysis model), one rewrite, held HOLD_HOURS; the
 *              agency row goes to "queued" so the push picks it up for the
 *              partners' campaign. Interested replies reach the owner, who
 *              sets up the creator's referral link by hand.
 */

type Log = (line: string) => void;

export const PARTNER_STATUSES = ["educator", "audience"] as const;

export async function handOverPartners(limit: number, log: Log) {
  const todo = (await db().execute(sql`
    select id from creators
    where status in ('educator', 'audience') and agency_id is null and links <> '{}'::jsonb
    order by updated_at limit ${limit}`)) as unknown as { id: string }[];
  const tally: Record<string, number> = {};
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
      const key = agencyKey(site, email);
      const made = await db()
        .insert(agencies)
        .values({ name: c.title, domain: key, website: site, country: c.country, status: "partner", fitScore: c.fitScore })
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
  if (todo.length) log(`partners handed over: ${JSON.stringify(tally)}`);
}

const WRITER = `You write a cold email sequence from Chao, founder of macaws.ai, to a YouTube creator, inviting them to become a referral partner.
${PARTNER_FACTS}

Return ONLY a JSON object: {"subject": string, "body": string, "body_2": string, "body_3": string, "body_4": string}.
- subject: under 50 characters, lower-key, no exclamation marks, no capitals for emphasis; hint at the partnership.
- body (first email, day 0): 70-120 words, plain text, UK English, short paragraphs. Greet by first name if given, else "Hi there". Open with one of their recent videos, by its topic, naturally (not "I watched your video", no flattery), and why their audience fits. Then say plainly what local.macaws.ai does for a local business, in one sentence. Then the offer: 40% of what every business they refer pays, for life. Write ${PARTNER_URL} out exactly once on its own line so they can see it. Close with one soft question: would they like a referral link (they just reply).
- body_2 (day 3, a reply in the same thread): 35-70 words. One different angle: e.g. their viewers can run the free check on local.macaws.ai without signing up, which makes it an easy thing to show on screen. Short question.
- body_3 (day 7): 50-100 words. The numbers, plainly: £49 a month per business, so about £19.60 a month to them for every business that stays; no cost or minimum to join; reply and Chao sends their link. Soft question.
- body_4 (day 14): 25-55 words. A short, friendly last note: you'll stop writing; the offer stands if they reply later.
- No sign-off or name (added later). The only link allowed anywhere is ${PARTNER_URL}. No placeholders, no hype (game-changer, skyrocket, passive income machine), no flattery, no invented numbers, results or terms.`;

const CHECKER = `You check a cold email sequence to a YouTube creator before it is sent, against the facts and the channel details given.
True facts, which the emails may state:
${PARTNER_FACTS}
Return ONLY a JSON object: {"ok": boolean, "notes": string[]}.
ok is false if the first email does not make the offer plain (40% of what referred businesses pay, for life, for promoting local.macaws.ai); any email states terms or facts not given (payout schedule, bonuses, a sign-up page, results), misdescribes their channel, is pushy, guilt-tripping, flattering or hype-y, reads as a template, or would embarrass the sender. notes: short, specific fixes (empty when ok).`;

export async function draftPartners(limit: number, log: Log) {
  const todo = (await db().execute(sql`
    select c.id from contacts c join agencies a on a.id = c.agency_id
    where c.source like 'partner:%' and c.email_status = 'valid' and a.status = 'partner'
      and not exists (select 1 from messages m where m.contact_id = c.id)
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    limit ${limit}`)) as unknown as { id: string }[];
  const tally: Record<string, number> = {};
  for (const { id } of todo) {
    const r = await draftPartner(id).catch((e: unknown) => ({ passed: false, why: e instanceof Error ? e.message : String(e) }));
    const k = "why" in r ? "failed" : r.passed ? "queued" : "needs_review";
    tally[k] = (tally[k] ?? 0) + 1;
  }
  if (todo.length) log(`partner emails: ${JSON.stringify(tally)}`);
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
  const writer = contact.writerModel ?? writerFor(contact.id);
  if (writer !== contact.writerModel) await db().update(contacts).set({ writerModel: writer, updatedAt: new Date() }).where(eq(contacts.id, contact.id));

  const brief = [
    `First name: ${contact.firstName?.trim() || "(unknown)"}`,
    `Channel: "${c.title}" (${c.subscribers ?? "?"} subscribers, country ${c.country ?? "?"})`,
    `Who watches them: ${c.kind === "educator" ? "marketers and agencies (they teach marketing)" : "local business owners"}`,
    `About them: ${c.qualifyNotes ?? ""}`,
    `Recent videos:`,
    ...c.recentVideos.slice(0, 5).map((v) => `- "${v.title}" (${v.publishedAt.slice(0, 10)})`),
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
    notes = partnerProblems(draft, PARTNER_URL);
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
    .where(eq(agencies.id, contact.agencyId));
  return { passed };
}
