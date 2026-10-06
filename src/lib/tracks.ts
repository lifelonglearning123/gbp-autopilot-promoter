import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, agencyResearch, contacts, events, messages, samples } from "@/db/schema";
import { env } from "@/env";
import { bodyHtml, emailsSentTo, replyInThread, takeOutOfCampaign } from "./instantly";
import { actionLink } from "./links";
import { esc, tellOwner } from "./notify";
import { OFFER_FACTS } from "./offer";
import { askJson } from "./openrouter";
import { shortClaimUrl, type SampleResult } from "./platform";

/**
 * After the cold sequence: reacting to what each agency does.
 *   Opened the audit, no reply   → a short personal note in the same thread
 *                                   (held WARM_HOLD_HOURS for the owner to
 *                                   stop), then out of the cold sequence.
 *   Claimed their account        → out of the cold sequence; owner told.
 *   Replied "not now"            → a check-in ~75 days later, written then,
 *                                   held 24 hours, sent in the same thread.
 * Messages: step 10 = warm note, step 20 = check-in. Nothing here sends while
 * paused (the caller checks).
 */

export const STEP_WARM = 10;
export const STEP_CHECK_IN = 20;
const WARM_HOLD_HOURS = 2;
const CHECK_IN_DAYS = 75;

type Log = (line: string) => void;

const WARM = `You write a short personal email from Chao, founder of GBP Autopilot, to someone at a marketing agency who was sent a sample Google Business Profile audit in their own brand (details below). It is a reply in the same email thread.
${OFFER_FACTS}

Return ONLY a JSON object: {"body": string}.
- 40-80 words, plain text, UK English, greet by first name (else "Hi there").
- Offer, simply, to run the same audit for one of their real clients: they reply with the business name and town and get it back in their brand. Mention they can also claim their account and run three audits themselves, with the CLAIM LINK written out once on its own line.
- Do NOT say or hint that you know they opened or viewed anything.
- No sign-off (added later), no hype, no flattery, no other links, no placeholders. Use only the facts given.`;

const CHECK_IN = `You write a short check-in email from Chao, founder of GBP Autopilot, to someone at a marketing agency who replied a while ago that it was "not now". It is a reply in the same thread.
${OFFER_FACTS}

Return ONLY a JSON object: {"body": string}.
- 40-80 words, plain text, UK English, greet by first name (else "Hi there"). Refer lightly to their earlier reply (quoted below).
- Ask whether now is a better time, and offer to run a fresh audit for one of their clients. One soft question.
- No sign-off (added later), no guilt, no hype, no links, no placeholders. Use only the facts given.`;

const CHECKER = `You check a short one-to-one sales email before it is sent, against the facts given.
True facts about our offer:
${OFFER_FACTS}
Return ONLY a JSON object: {"ok": boolean, "notes": string[]}.
ok is false if it states anything not supported by the facts, mentions tracking or that they opened/viewed something, is pushy, guilt-tripping or hype-y, has a link other than the ones given, or would embarrass the sender.`;

function footer(): string {
  const legal = (env.SENDER_LEGAL ?? "").replace(/\\n/g, "\n");
  return `\n\n${env.SENDER_SIGNOFF.replace(/\\n/g, "\n")}\n\n${legal}\nNot relevant? Reply "remove" and I will take you off this list straight away.`;
}

async function writeChecked(system: string, brief: string, allowed: string[]): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data } = await askJson<{ body: string }>({ model: env.WRITER_MODELS.split(",")[0].trim(), system, user: brief, maxTokens: 600 });
    const body = String(data.body ?? "").trim();
    const links = (body.match(/https?:\/\/\S+/g) ?? []).map((l) => l.replace(/[).,;:!?]+$/, ""));
    if (!body || body.split(/\s+/).length > 100 || links.some((l) => !allowed.includes(l)) || /\{\{|\}\}/.test(body)) continue;
    const { data: check } = await askJson<{ ok: boolean; notes: string[] }>({
      model: env.ANALYSIS_MODEL,
      system: CHECKER,
      user: `${brief}\n\nThe email:\n${body}`,
      maxTokens: 400,
    });
    if (check.ok) return body;
  }
  return null;
}

/** The lead's Instantly id in the main campaign, from its first email. */
async function leadOf(contactId: string): Promise<{ leadId: string; campaignId: string } | null> {
  const [m] = await db()
    .select({ leadId: messages.instantlyLeadId, campaignId: messages.instantlyCampaignId })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), eq(messages.step, 1)))
    .limit(1);
  return m?.leadId && m.campaignId ? { leadId: m.leadId, campaignId: m.campaignId } : null;
}

async function noteOnce(type: string, contactId: string, agencyId: string, payload: Record<string, unknown> = {}) {
  await db().insert(events).values({ source: "bot", type, contactId, agencyId, payload });
}

/* ── Opened the audit → a warm note ─────────────────────────────────────── */

export async function draftWarmNotes(log: Log) {
  const todo = (await db().execute(sql`
    select distinct on (c.id) c.id contact_id, c.first_name, a.id agency_id, a.name agency
    from events e
    join contacts c on c.id = e.contact_id
    join agencies a on a.id = c.agency_id
    where e.source = 'platform' and e.type = 'sample.viewed'
      and a.status in ('queued', 'contacted')
      and exists (select 1 from messages m where m.contact_id = c.id and m.step = 1 and m.pushed_at is not null)
      and not exists (select 1 from messages m where m.contact_id = c.id and m.step = ${STEP_WARM})
      and not exists (select 1 from replies r where r.contact_id = c.id)
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    order by c.id limit 10`)) as unknown as { contact_id: string; first_name: string | null; agency_id: string; agency: string }[];

  for (const t of todo) {
    const [sample] = await db().select().from(samples).where(eq(samples.contactId, t.contact_id)).orderBy(desc(samples.createdAt)).limit(1);
    if (!sample) continue;
    const result = sample.result as unknown as SampleResult;
    const [research] = await db()
      .select({ summary: agencyResearch.summary })
      .from(agencyResearch)
      .where(eq(agencyResearch.agencyId, t.agency_id))
      .orderBy(desc(agencyResearch.version))
      .limit(1);
    const claim = shortClaimUrl(sample) ?? sample.previewUrl;
    const brief = `First name: ${t.first_name ?? "(unknown)"}\nAgency: ${t.agency}\nResearch: ${research?.summary ?? ""}\nThe audit sent: "${result.title}", score ${result.score}/100.\nClaim link: ${claim}`;
    const body = await writeChecked(WARM, brief, [claim, sample.previewUrl]);
    if (!body) {
      log(`warm note for ${t.agency}: writer failed the check twice, skipped`);
      continue;
    }
    const [m] = await db()
      .insert(messages)
      .values({
        contactId: t.contact_id,
        writerModel: env.WRITER_MODELS.split(",")[0].trim(),
        step: STEP_WARM,
        subject: null,
        body,
        guardrail: { ok: true, notes: ["warm: opened the audit"] },
        holdUntil: new Date(Date.now() + WARM_HOLD_HOURS * 3_600_000),
      })
      .returning({ id: messages.id });
    await tellOwner(
      `${t.agency} opened their audit — a note goes in ${WARM_HOLD_HOURS} hours`,
      `<p><b>${esc(t.first_name ?? "")} at ${esc(t.agency)}</b> opened the sample audit. This note goes to them, as a reply in the same thread, in ${WARM_HOLD_HOURS} hours, and they come out of the cold sequence:</p>
       <blockquote style="border-left:3px solid #ccc;padding-left:12px">${esc(body).replace(/\n/g, "<br>")}</blockquote>
       <p><a href="${actionLink("stop", m.id)}">Stop this note</a> · or write to them yourself from Instantly's Unibox.</p>`,
    ).catch(() => {});
    log(`warm note drafted for ${t.agency}; owner told`);
  }
}

/* ── Claimed their account → out of the cold sequence ───────────────────── */

export async function stopClaimed(log: Log) {
  const todo = (await db().execute(sql`
    select c.id contact_id, a.id agency_id, a.name agency
    from agencies a join contacts c on c.agency_id = a.id
    where a.status in ('claimed', 'customer')
      and exists (select 1 from messages m where m.contact_id = c.id and m.step = 1 and m.instantly_lead_id is not null)
      and not exists (select 1 from events e where e.contact_id = c.id and e.type = 'lead.taken_out')
    limit 20`)) as unknown as { contact_id: string; agency_id: string; agency: string }[];
  for (const t of todo) {
    const lead = await leadOf(t.contact_id);
    if (!lead) continue;
    await takeOutOfCampaign(lead.leadId, lead.campaignId);
    await noteOnce("lead.taken_out", t.contact_id, t.agency_id, { why: "claimed their account" });
    await tellOwner(
      `${t.agency} claimed their account`,
      `<p><b>${esc(t.agency)}</b> claimed their GBP Autopilot account. Cold emails to them have stopped; they're yours to look after now.</p>`,
    ).catch(() => {});
    log(`${t.agency} claimed: out of the cold sequence, owner told`);
  }
}

/* ── "Not now" → a check-in later ───────────────────────────────────────── */

export async function scheduleCheckIns(log: Log) {
  const todo = (await db().execute(sql`
    select distinct on (r.contact_id) r.contact_id, r.received_at
    from replies r
    where r.classification = 'not_now'
      and not exists (select 1 from contacts c where c.id = r.contact_id and c.source like 'partner:%')
      and not exists (select 1 from messages m where m.contact_id = r.contact_id and m.step = ${STEP_CHECK_IN})
    order by r.contact_id, r.received_at desc`)) as unknown as { contact_id: string; received_at: string }[];
  for (const t of todo) {
    await db().insert(messages).values({
      contactId: t.contact_id,
      writerModel: "pending",
      step: STEP_CHECK_IN,
      subject: null,
      body: "(written when due)",
      guardrail: { ok: false, notes: ["pending: written when due"] },
      holdUntil: new Date(new Date(t.received_at).getTime() + CHECK_IN_DAYS * 86_400_000),
    });
  }
  if (todo.length) log(`check-ins scheduled for ${todo.length} "not now" replies, in ${CHECK_IN_DAYS} days`);
}

/** Write check-ins that have come due; they then wait 24 hours (shown in the daily summary). */
export async function writeDueCheckIns(log: Log) {
  const due = (await db().execute(sql`
    select m.id, m.contact_id, c.first_name, a.name agency,
           (select body from replies r where r.contact_id = m.contact_id order by received_at desc limit 1) their_reply
    from messages m join contacts c on c.id = m.contact_id join agencies a on a.id = c.agency_id
    where m.step = ${STEP_CHECK_IN} and m.writer_model = 'pending' and m.hold_until <= now() and m.stopped_at is null
    limit 10`)) as unknown as { id: string; contact_id: string; first_name: string | null; agency: string; their_reply: string | null }[];
  for (const t of due) {
    const brief = `First name: ${t.first_name ?? "(unknown)"}\nAgency: ${t.agency}\nTheir earlier reply: ${(t.their_reply ?? "").slice(0, 800)}`;
    const body = await writeChecked(CHECK_IN, brief, []);
    if (!body) continue;
    await db()
      .update(messages)
      .set({ body, writerModel: env.WRITER_MODELS.split(",")[0].trim(), guardrail: { ok: true, notes: ["check-in"] }, holdUntil: new Date(Date.now() + 24 * 3_600_000) })
      .where(eq(messages.id, t.id));
    log(`check-in written for ${t.agency}; goes in 24 hours`);
  }
}

/* ── Send one-to-one notes whose hold has ended ─────────────────────────── */

export async function sendDueNotes(log: Log) {
  const due = (await db().execute(sql`
    select m.id, m.step, m.body, m.contact_id, c.email, a.id agency_id, a.name agency
    from messages m join contacts c on c.id = m.contact_id join agencies a on a.id = c.agency_id
    where m.step in (${STEP_WARM}, ${STEP_CHECK_IN}) and m.sent_at is null and m.stopped_at is null
      and (m.guardrail->>'ok')::boolean and m.hold_until <= now()
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    limit 20`)) as unknown as { id: string; step: number; body: string; contact_id: string; email: string; agency_id: string; agency: string }[];
  for (const t of due) {
    // A warm note is pointless once they have replied themselves.
    if (t.step === STEP_WARM) {
      const [r] = (await db().execute(sql`select 1 from replies where contact_id = ${t.contact_id} limit 1`)) as unknown[];
      if (r) {
        await db().update(messages).set({ stoppedAt: new Date() }).where(eq(messages.id, t.id));
        continue;
      }
    }
    const lead = await leadOf(t.contact_id);
    if (!lead) continue;
    const [first] = await emailsSentTo(t.email, lead.campaignId);
    if (!first) continue; // the first email has not gone yet: wait
    const subject = first.subject.startsWith("Re:") ? first.subject : `Re: ${first.subject}`;
    await replyInThread({ replyToId: first.id, eaccount: first.eaccount, subject, html: bodyHtml(t.body + footer()) });
    await db().update(messages).set({ sentAt: new Date() }).where(eq(messages.id, t.id));
    if (t.step === STEP_WARM) {
      await takeOutOfCampaign(lead.leadId, lead.campaignId).catch(() => {});
      await noteOnce("lead.taken_out", t.contact_id, t.agency_id, { why: "warm note sent" });
    }
    log(`${t.step === STEP_WARM ? "warm note" : "check-in"} sent to ${t.agency}`);
  }
}
