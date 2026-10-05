import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, controls, creators, messages, outreachTasks, replies } from "@/db/schema";
import { env } from "@/env";
import { agencyKey, emailType, tidyEmail } from "./contact-rules";
import { emailsIn, hostOf, instagramHandle, phonesIn, sortLinks } from "./creator-rules";
import { OFFER_FACTS } from "./offer";
import { askJson } from "./openrouter";
import { channels, recentUploads, searchVideos } from "./youtube";

/**
 * YouTube creators posting about local SEO / Google Business Profile:
 *   discover   search recent videos, keep new English channels
 *   qualify    the analysis model: agency/freelancer (a buyer), educator, or skip
 *   enrich     public contact details from the description, website and link page
 *   hand over  a creator with an email becomes an agency + contact, so the
 *              normal pipeline researches, audits, writes and emails them
 *   tasks      Instagram / Skool / phone messages for a person to send
 * Every detail keeps where it was published (CASL asks for proof of source).
 */

type Log = (line: string) => void;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/* ── Discover ───────────────────────────────────────────────────────────── */

/** Two search phrases a run, in turn, over the last 30 days. */
export async function discoverCreators(log: Log) {
  if (!env.YOUTUBE_API_KEY) return;
  const phrases = env.YOUTUBE_QUERIES.split("|").map((p) => p.trim()).filter(Boolean);
  const [row] = await db().select().from(controls).where(eq(controls.key, "youtube")).limit(1);
  const state = (row?.value as { next?: number; day?: string; searches?: number } | undefined) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  const searches = state.day === today ? (state.searches ?? 0) : 0;
  if (searches >= 40) return; // 4,000 of the 10,000 daily units: room to spare
  let next = state.next ?? 0;
  const found = new Map<string, string>();
  for (let i = 0; i < 2; i++) {
    const phrase = phrases[next % phrases.length];
    next++;
    const { videos } = await searchVideos(phrase, new Date(Date.now() - 30 * 86_400_000));
    for (const v of videos) if (!found.has(v.channelId)) found.set(v.channelId, phrase);
  }
  await db()
    .insert(controls)
    .values({ key: "youtube", value: { next, day: today, searches: searches + 2 } })
    .onConflictDoUpdate({ target: controls.key, set: { value: { next, day: today, searches: searches + 2 }, updatedAt: new Date() } });

  const known = new Set(
    (await db().select({ id: creators.channelId }).from(creators).where(inArray(creators.channelId, [...found.keys(), ""]))).map((r) => r.id),
  );
  const fresh = [...found.keys()].filter((id) => !known.has(id));
  let added = 0;
  for (let i = 0; i < fresh.length; i += 50) {
    for (const c of await channels(fresh.slice(i, i + 50))) {
      // Too new to be a business, or a brand too big to answer a cold email.
      if ((c.videoCount ?? 0) < 5 || (c.subscribers ?? 0) > 1_000_000) continue;
      const recent = c.uploads ? await recentUploads(c.uploads).catch(() => []) : [];
      await db()
        .insert(creators)
        .values({
          channelId: c.channelId,
          title: c.title,
          handle: c.handle,
          country: c.country,
          subscribers: c.subscribers,
          videoCount: c.videoCount,
          description: c.description,
          recentVideos: recent,
          foundBy: found.get(c.channelId),
        })
        .onConflictDoNothing();
      added++;
    }
  }
  log(`youtube: ${found.size} channels in results, ${added} new`);
}

/* ── Qualify ────────────────────────────────────────────────────────────── */

const QUALIFY = `You sort YouTube channels for GBP Autopilot, a white-label Google Business Profile platform that marketing agencies resell to local businesses (built to work with GoHighLevel).
Return ONLY a JSON object: {"kind": "agency"|"educator"|"skip", "fit_score": 0-100, "uses_ghl": boolean, "english": boolean, "country": string|null, "reason": string}.
- "agency": a marketing agency, freelancer or consultant who SELLS local SEO, Google Business Profile, Google Maps or local marketing services to businesses (a potential buyer to resell our platform).
- "educator": teaches agencies or marketers (courses, coaching, communities, SaaS/GHL tutorials) — their audience is agencies; a potential referral partner.
- "skip": a local business marketing itself, a big brand, news, or unrelated.
fit_score: how likely they would resell white-label GBP management to local clients. uses_ghl: they mention GoHighLevel/HighLevel or a GHL SaaS. english: the channel is in English.
Judge only from what is given.`;

export async function qualifyCreators(limit: number, log: Log) {
  const todo = await db().select().from(creators).where(eq(creators.status, "new")).orderBy(asc(creators.createdAt)).limit(limit);
  const tally: Record<string, number> = {};
  for (const c of todo) {
    const { data } = await askJson<{ kind: string; fit_score: number; uses_ghl: boolean; english: boolean; country: string | null; reason: string }>({
      model: env.ANALYSIS_MODEL,
      system: QUALIFY,
      user: `Channel: ${c.title} (${c.handle ?? "-"}), ${c.subscribers ?? "?"} subscribers, ${c.videoCount ?? "?"} videos, country ${c.country ?? "?"}\nFound by searching: ${c.foundBy}\nDescription:\n${(c.description ?? "").slice(0, 3000)}\nRecent videos:\n${c.recentVideos.map((v) => `- ${v.title}`).join("\n")}`,
      maxTokens: 500,
    }).catch(() => ({ data: null }));
    if (!data) continue;
    const kind = !data.english ? "skip" : ["agency", "educator"].includes(data.kind) ? data.kind : "skip";
    const fit = Math.max(0, Math.min(100, Math.round(Number(data.fit_score) || 0)));
    // Educators wait for the partner offer; weak agency fits are not written to.
    const status = kind === "skip" || (kind === "agency" && fit < 40) ? "skipped" : kind === "educator" ? "educator" : "qualified";
    await db()
      .update(creators)
      .set({ kind, fitScore: fit, usesGhl: !!data.uses_ghl, country: c.country ?? data.country, qualifyNotes: data.reason, status, updatedAt: new Date() })
      .where(eq(creators.id, c.id));
    tally[status] = (tally[status] ?? 0) + 1;
  }
  if (todo.length) log(`youtube qualified: ${JSON.stringify(tally)}`);
}

/* ── Enrich: public contact details ─────────────────────────────────────── */

async function html(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    return res.ok ? (await res.text()).slice(0, 1_500_000) : "";
  } catch {
    return "";
  }
}

/** Links in a page's HTML (href values), for sortLinks. */
function hrefs(page: string): string {
  return [...page.matchAll(/href=["'](https?:\/\/[^"'#]+)["']/gi)].map((m) => m[1]).join("\n");
}

export async function enrichCreators(limit: number, log: Log) {
  const todo = await db()
    .select()
    .from(creators)
    .where(inArray(creators.status, ["qualified", "educator"]))
    .orderBy(asc(creators.updatedAt))
    .limit(limit);
  let n = 0;
  for (const c of todo.filter((t) => Object.keys(t.links).length === 0 && t.emails.length === 0)) {
    const youtube = `https://www.youtube.com/channel/${c.channelId}`;
    const desc = c.description ?? "";
    const links: Record<string, string> = { youtube, ...sortLinks(desc) };
    const emails = emailsIn(desc).map((email) => ({ email, source: youtube }));
    const phones = phonesIn(desc).map((phone) => ({ phone, source: youtube }));

    // Their link page and website: more links, and published emails and phones.
    for (const kind of ["linktree", "website"] as const) {
      const url = links[kind];
      if (!url) continue;
      const page = await html(url);
      if (!page) continue;
      for (const [k, v] of Object.entries(sortLinks(hrefs(page)))) if (!links[k] && hostOf(v) !== hostOf(url)) links[k] = v;
      for (const email of emailsIn(page.replace(/<[^>]+>/g, " "))) emails.push({ email, source: url });
      for (const phone of phonesIn(page)) phones.push({ phone, source: url });
      // A contact page often has what the home page does not.
      if (kind === "website") {
        const contact = [...page.matchAll(/href=["']([^"']*contact[^"']*)["']/gi)].map((m) => m[1])[0];
        if (contact) {
          const curl = new URL(contact, url).toString();
          const cpage = await html(curl);
          for (const email of emailsIn(cpage.replace(/<[^>]+>/g, " "))) emails.push({ email, source: curl });
          for (const phone of phonesIn(cpage)) phones.push({ phone, source: curl });
        }
      }
    }
    const uniq = <T, K>(xs: T[], key: (x: T) => K) => xs.filter((x, i) => xs.findIndex((y) => key(y) === key(x)) === i);
    await db()
      .update(creators)
      .set({
        links,
        emails: uniq(emails, (e) => e.email).slice(0, 5),
        phones: uniq(phones, (p) => p.phone.replace(/\D/g, "")).slice(0, 3),
        status: c.status === "educator" ? "educator" : "enriched",
        updatedAt: new Date(),
      })
      .where(eq(creators.id, c.id));
    n++;
  }
  if (n) log(`youtube: contact details collected for ${n} creators`);
}

/* ── Hand over to the email pipeline ────────────────────────────────────── */

/**
 * An enriched agency creator with an email becomes an agency (by its site's
 * domain) and a contact, so research, the audit, the four emails and every
 * check run as for the GHL list. Its emails go to the creators' campaign.
 */
export async function handOverCreators(limit: number, log: Log) {
  const todo = await db().select().from(creators).where(and(eq(creators.status, "enriched"), isNull(creators.agencyId))).limit(limit);
  let n = 0;
  for (const c of todo) {
    // A work address on their own domain first.
    const site = c.links.website ?? null;
    const siteHost = site ? hostOf(site) : null;
    const pick =
      c.emails.find((e) => siteHost && e.email.endsWith(`@${siteHost}`)) ?? c.emails.find((e) => emailType(e.email) === "work") ?? c.emails[0];
    const email = tidyEmail(pick?.email);
    if (!email) {
      await db().update(creators).set({ status: "no_email", updatedAt: new Date() }).where(eq(creators.id, c.id));
      continue;
    }
    const key = agencyKey(site, email);
    await db()
      .insert(agencies)
      .values({ name: c.title, domain: key, website: site, country: c.country })
      .onConflictDoNothing({ target: agencies.domain });
    const [agency] = await db().select({ id: agencies.id }).from(agencies).where(eq(agencies.domain, key)).limit(1);
    await db()
      .insert(contacts)
      .values({
        agencyId: agency.id,
        email,
        emailType: emailType(email),
        phone: c.phones[0]?.phone ?? null,
        country: c.country,
        source: `youtube:${c.channelId}`,
        sourceProof: { url: pick.source, seenAt: new Date().toISOString() },
      })
      .onConflictDoNothing();
    await db().update(creators).set({ agencyId: agency.id, status: "in_pipeline", updatedAt: new Date() }).where(eq(creators.id, c.id));
    n++;
  }
  if (n) log(`youtube: ${n} creators handed to the email pipeline`);
}

/** What the writer may say about a creator's channel, for an agency we write to. */
export async function creatorContext(agencyId: string): Promise<string | null> {
  const [c] = await db().select().from(creators).where(eq(creators.agencyId, agencyId)).limit(1);
  if (!c) return null;
  return [
    `They run a YouTube channel, "${c.title}" (${c.subscribers ?? "?"} subscribers), about local SEO / Google Business Profile.`,
    `Their recent videos:`,
    ...c.recentVideos.slice(0, 5).map((v) => `- "${v.title}" (${v.publishedAt.slice(0, 10)})`),
  ].join("\n");
}

/* ── Messages for a person to send ──────────────────────────────────────── */

const DMS = `You write short direct messages from Chao, founder of GBP Autopilot, to a YouTube creator who runs a marketing agency or sells local SEO.
${OFFER_FACTS}

Return ONLY a JSON object: {"instagram": string, "skool": string, "phone_script": string}.
- instagram: 25-50 words, casual, mention one of their recent videos by its topic, say we built a white-label Google Business Profile service that works inside GoHighLevel, offer to send them a free audit in their brand. One question. No links.
- skool: 40-70 words, a little fuller than Instagram, same content, friendly and community-appropriate. No links.
- phone_script: 60-100 words for a short call: who you are, why them (their channel and videos), the offer in one line, ask for 10 minutes or permission to email the audit. Plain spoken English.
UK English. No hype, no flattery, no placeholders. Never claim to be from HighLevel.`;

/**
 * For each creator: a message per network they publish (Instagram, Skool) and
 * a call script if they publish a phone. Due 3 days after their first email
 * (so the email lands first), or now if there is no email to send.
 */
export async function queueTasks(limit: number, log: Log) {
  const ids = (await db().execute(sql`
    select cr.id from creators cr
    where cr.status in ('in_pipeline', 'no_email')
      and not exists (select 1 from outreach_tasks t where t.creator_id = cr.id)
      and (cr.links ? 'instagram' or cr.links ? 'skool' or jsonb_array_length(cr.phones) > 0)
    limit ${limit}`)) as unknown as { id: string }[];
  const todo = ids.length ? await db().select().from(creators).where(inArray(creators.id, ids.map((r) => r.id))) : [];
  let n = 0;
  for (const c of todo) {
    const recent = c.recentVideos.slice(0, 4).map((v) => `- ${v.title}`).join("\n");
    const { data } = await askJson<{ instagram: string; skool: string; phone_script: string }>({
      model: env.WRITER_MODELS.split(",")[0].trim(),
      system: DMS,
      user: `Channel: ${c.title}
About them: ${c.qualifyNotes ?? ""}
Uses GoHighLevel: ${c.usesGhl ? "yes" : "unknown"}
Recent videos:
${recent}`,
      maxTokens: 800,
    }).catch(() => ({ data: null }));
    if (!data) continue;

    let due = new Date();
    if (c.agencyId) {
      const [first] = (await db().execute(sql`
        select coalesce(m.sent_at, m.hold_until, now()) at from messages m join contacts ct on ct.id = m.contact_id
        where ct.agency_id = ${c.agencyId} and m.step = 1 order by m.created_at limit 1`)) as unknown as { at: string }[];
      due = new Date(new Date(first?.at ?? Date.now()).getTime() + 3 * 86_400_000);
    }
    const links = c.links;
    const rows: (typeof outreachTasks.$inferInsert)[] = [];
    if (links.instagram && instagramHandle(links.instagram)) rows.push({ creatorId: c.id, channel: "instagram", target: links.instagram, message: data.instagram, dueAt: due });
    if (links.skool) rows.push({ creatorId: c.id, channel: "skool", target: links.skool, message: data.skool, dueAt: new Date(due.getTime() + 86_400_000) });
    const phones = c.phones;
    if (phones[0]) rows.push({ creatorId: c.id, channel: "phone", target: phones[0].phone, message: data.phone_script, dueAt: new Date(due.getTime() + 2 * 86_400_000) });
    if (rows.length) await db().insert(outreachTasks).values(rows);
    n++;
  }
  if (n) log(`youtube: DM / call messages written for ${n} creators`);
}

/** Stop a creator's open tasks once they have answered anywhere. */
export async function closeAnsweredTasks() {
  await db().execute(sql`
    update outreach_tasks t set skipped_at = now()
    where t.done_at is null and t.skipped_at is null
      and (exists (select 1 from outreach_tasks r where r.creator_id = t.creator_id and r.replied_at is not null)
        or exists (select 1 from creators cr join contacts ct on ct.agency_id = cr.agency_id
                   join replies rp on rp.contact_id = ct.id where cr.id = t.creator_id))`);
}

export const _forTests = { messages, replies };
