import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, controls, events, messages, replies, suppression } from "@/db/schema";
import { env } from "@/env";
import { pauseAll, pausedState } from "./control";
import { draftFirstEmail } from "./draft";
import { draftFollowUps, followUpVars, syncFollowUps } from "./followups";
import { verifyEmailGhl } from "./ghl";
import { importGhl } from "./import-ghl";
import { addLeads, blockList, bodyHtml } from "./instantly";
import { actionLink } from "./links";
import { esc, tellOwner } from "./notify";
import { askJson } from "./openrouter";
import { researchAgency } from "./research";
import { contactsFromSites, discoverHighLevel } from "./highlevel";
import { closeAnsweredTasks, discoverCreators, discoverTikTok, enrichCreators, qualifyCreators, queueTasks } from "./creators";
import { syncCreatorsToGhl } from "./ghl-crm";
import { draftPartners, handOverPartners } from "./partners";
import { draftWarmNotes, scheduleCheckIns, sendDueNotes, stopClaimed, writeDueCheckIns } from "./tracks";

/**
 * The work the hourly run does, each step bounded so a run fits its time.
 * Replies are always handled (a "remove" is honoured even while paused);
 * everything that reaches anyone outside stops while the owner has paused.
 */

type Log = (line: string) => void;
const left = (deadline: number) => deadline - Date.now();

/** Many at once, until the list or the time runs out. */
async function pool<T>(items: T[], parallel: number, deadline: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (let t = queue.shift(); t !== undefined && left(deadline) > 90_000; t = queue.shift()) {
        await fn(t).catch(() => {});
      }
    }),
  );
}

/* ── Intake: once a day ─────────────────────────────────────────────────── */

export async function dailyIntake(log: Log) {
  const today = new Date().toISOString().slice(0, 10);
  const [row] = await db().select().from(controls).where(eq(controls.key, "intake")).limit(1);
  if ((row?.value as { day?: string } | undefined)?.day === today) return;
  const c = await importGhl({ write: true });
  log(`intake: ${c.newAgencies} new agencies, ${c.newContacts} new contacts from GHL`);
  await db()
    .insert(controls)
    .values({ key: "intake", value: { day: today, ...c } })
    .onConflictDoUpdate({ target: controls.key, set: { value: { day: today, ...c }, updatedAt: new Date() } });
}

export async function verifySome(limit: number, deadline: number, log: Log) {
  const todo = await db()
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.emailStatus, "unverified"))
    .orderBy(asc(contacts.createdAt))
    .limit(limit);
  let n = 0;
  await pool(todo, 3, deadline, async (c) => {
    const v = await verifyEmailGhl(c.email);
    await db().update(contacts).set({ emailStatus: v, updatedAt: new Date() }).where(eq(contacts.id, c.id));
    n++;
  });
  if (todo.length) log(`verified ${n} of ${todo.length} new addresses`);
}

export async function researchSome(limit: number, deadline: number, log: Log) {
  const todo = await db().select({ id: agencies.id }).from(agencies).where(eq(agencies.status, "new")).orderBy(asc(agencies.createdAt)).limit(limit);
  const tally: Record<string, number> = {};
  await pool(todo, 3, deadline, async (a) => {
    const r = await researchAgency(a.id);
    const k = r.ok ? r.status : r.why;
    tally[k] = (tally[k] ?? 0) + 1;
  });
  if (todo.length) log(`researched: ${JSON.stringify(tally)}`);
}

export async function draftSome(limit: number, deadline: number, log: Log) {
  const todo = (await db().execute(sql`
    select distinct on (a.id) c.id
    from agencies a join contacts c on c.agency_id = a.id
    where a.status = 'researched' and c.email_status = 'valid'
      and not exists (select 1 from messages m join contacts c2 on c2.id = m.contact_id where c2.agency_id = a.id)
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    order by a.id, (c.email_type = 'work') desc, c.created_at
    limit ${limit}`)) as unknown as { id: string }[];
  const tally: Record<string, number> = {};
  await pool(todo, 3, deadline, async (c) => {
    const r = await draftFirstEmail(c.id);
    // The whole sequence is written at once: a lead is only pushed with all four.
    if (r.ok && r.passed) await draftFollowUps(c.id);
    const k = r.ok ? (r.passed ? "queued" : "needs_review") : r.why.split(":")[0];
    tally[k] = (tally[k] ?? 0) + 1;
  });
  if (todo.length) log(`drafted: ${JSON.stringify(tally)}`);
}

/** Leads already in the campaign without follow-ups (a failed write) get them. */
export async function backfillFollowUps(limit: number, deadline: number, log: Log) {
  const todo = (await db().execute(sql`
    select m.contact_id id from messages m
    where m.step = 1 and m.pushed_at is not null
      and not exists (select 1 from messages f where f.contact_id = m.contact_id and f.step = 4)
    limit ${limit}`)) as unknown as { id: string }[];
  let n = 0;
  await pool(todo, 2, deadline, async (c) => {
    if ((await draftFollowUps(c.id)).ok) n++;
  });
  if (todo.length) log(`follow-ups written for ${n} of ${todo.length} leads missing them`);
}

/* ── Push: drafts whose hold has passed ─────────────────────────────────── */

type Track = "main" | "youtube" | "partner";
const TRACK_NAME: Record<Track, string> = { main: "main", youtube: "YouTube creators'", partner: "creator partners'" };

/** Push due emails: the GHL list to the main campaign, creators (the creator offer) to theirs; the YouTube campaign keeps its earlier leads. */
export async function pushDue(limit: number, log: Log): Promise<number> {
  const main = await pushInto(env.INSTANTLY_CAMPAIGN_ID, "main", limit, log);
  const yt = await pushInto(env.INSTANTLY_YT_CAMPAIGN_ID, "youtube", limit, log);
  const partners = await pushInto(env.INSTANTLY_PARTNER_CAMPAIGN_ID, "partner", limit, log);
  return main + yt + partners;
}

async function pushInto(campaignId: string | undefined, track: Track, limit: number, log: Log): Promise<number> {
  if (!campaignId) return 0;
  const ready = (await db().execute(sql`
    select m.id, m.subject, m.body, c.email, c.first_name, c.last_name, a.name agency, a.website
    from messages m
    join contacts c on c.id = m.contact_id
    join agencies a on a.id = c.agency_id
    where m.step = 1 and m.pushed_at is null and m.sent_at is null and m.stopped_at is null
      and (m.guardrail->>'ok')::boolean
      and (m.hold_until is null or m.hold_until <= now())
      and c.email_status = 'valid' and a.status = 'queued'
      and (case when c.source like 'youtube:%' then 'youtube' when c.source like 'partner:%' then 'partner' else 'main' end) = ${track}
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    order by m.created_at
    limit ${limit}`)) as unknown as {
    id: string;
    subject: string;
    body: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    agency: string;
    website: string | null;
  }[];
  if (ready.length === 0) return 0;

  const blocked = await db().select({ email: suppression.email, domain: suppression.domain }).from(suppression);
  await blockList(blocked.map((b) => b.email ?? b.domain).filter((v): v is string => !!v));

  // Each lead carries its whole sequence; one without follow-ups waits (they are written next run).
  const withFollowUps: (typeof ready[number] & { vars: Record<string, string> })[] = [];
  for (const r of ready) {
    const [m] = await db().select({ contactId: messages.contactId }).from(messages).where(eq(messages.id, r.id)).limit(1);
    let vars = await followUpVars(m.contactId, bodyHtml);
    if (!vars) {
      await draftFollowUps(m.contactId).catch(() => null);
      vars = await followUpVars(m.contactId, bodyHtml);
    }
    if (vars) withFollowUps.push({ ...r, vars });
  }
  ready.splice(0, ready.length, ...withFollowUps);
  if (ready.length === 0) return 0;

  const res = await addLeads(
    campaignId,
    withFollowUps.map((r) => ({
      email: r.email,
      first_name: r.first_name ?? undefined,
      last_name: r.last_name ?? undefined,
      company_name: r.agency,
      website: r.website ?? undefined,
      custom_variables: { subject: r.subject, body_html: bodyHtml(r.body), message_id: r.id, ...r.vars },
    })),
  );
  const now = new Date();
  for (const lead of res.created_leads ?? []) {
    const r = ready[lead.index];
    if (r) await db().update(messages).set({ instantlyCampaignId: campaignId, instantlyLeadId: lead.id, pushedAt: now }).where(eq(messages.id, r.id));
  }
  log(`pushed ${res.created_leads?.length ?? 0} of ${ready.length} into the ${TRACK_NAME[track]} campaign`);
  return res.created_leads?.length ?? 0;
}

/* ── Replies ────────────────────────────────────────────────────────────── */

const SORTER = `You sort replies to a cold email that offered either a marketing agency a white-label Google Business Profile service, or a YouTube creator a referral partnership (their own white-label version, free, 40% commission).
Return ONLY a JSON object: {"kind": string, "confidence": number 0-1, "summary": string (one short sentence)}.
kind is one of: "interested" (wants to know more, asks a question, wants a call or pricing), "not_now" (polite no for now, maybe later),
"remove" (asks to be removed, unsubscribed, not interested at all, hostile), "wrong_person" (not them, sends elsewhere),
"out_of_office" (automatic reply), "other".`;

export async function handleReplies(log: Log) {
  const todo = (await db().execute(sql`
    select r.id, r.body, r.contact_id, c.email, c.first_name, c.source, a.id agency_id, a.name agency, a.domain
    from replies r join contacts c on c.id = r.contact_id join agencies a on a.id = c.agency_id
    where r.classification is null order by r.received_at limit 20`)) as unknown as {
    id: string;
    body: string;
    contact_id: string;
    email: string;
    first_name: string | null;
    source: string;
    agency_id: string;
    agency: string;
    domain: string;
  }[];
  for (const r of todo) {
    let kind = "other";
    let confidence = 0;
    let summary = "";
    try {
      const { data } = await askJson<{ kind: string; confidence: number; summary: string }>({
        model: env.ANALYSIS_MODEL,
        system: SORTER,
        user: r.body.slice(0, 4000),
        maxTokens: 300,
      });
      kind = data.kind;
      confidence = Number(data.confidence) || 0;
      summary = data.summary ?? "";
    } catch {
      continue; // try again next run
    }
    const handled = ["remove", "out_of_office"].includes(kind);
    await db().update(replies).set({ classification: kind, confidence, handled }).where(eq(replies.id, r.id));

    if (kind === "remove") {
      await db().insert(suppression).values({ email: r.email, reason: "asked to be removed (reply)" }).onConflictDoNothing();
      await blockList([r.email]).catch(() => {});
      await db().update(agencies).set({ status: "suppressed", updatedAt: new Date() }).where(eq(agencies.id, r.agency_id));
      log(`reply: ${r.agency} asked to be removed — done`);
    } else if (kind === "interested" || kind === "other" || kind === "not_now" || kind === "wrong_person") {
      // Anything a person should read goes to the owner straight away.
      const urgent = kind === "interested";
      const partner = r.source.startsWith("partner:");
      await tellOwner(
        `${urgent ? "Interested reply" : "Reply"}${partner ? " (creator partner)" : ""}: ${r.agency}`,
        `<p><b>${esc(r.first_name ?? "")} at ${esc(r.agency)}</b> (${esc(r.domain)}) replied — sorted as <b>${esc(kind)}</b>.</p>
         <p>${esc(summary)}</p>
         <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#333">${esc(r.body.slice(0, 2000)).replace(/\n/g, "<br>")}</blockquote>
         ${partner && urgent ? `<p><b>A creator is interested in their own white-label GBP Autopilot (free, 40% for life).</b> Their claim link is in the email they replied to.</p>` : ""}
         <p>Answer it from Instantly's inbox (Unibox). The campaign has already stopped writing to them.</p>`,
      ).catch(() => {});
      await db().update(replies).set({ alertedAt: new Date() }).where(eq(replies.id, r.id));
      log(`reply: ${r.agency} — ${kind}, owner told`);
    }
  }
}

/* ── Safety: stop on its own when something looks wrong ─────────────────── */

export async function healthCheck(log: Log) {
  const [day] = (await db().execute(sql`
    select count(*) filter (where type = 'email_sent')::int sent,
           count(*) filter (where type = 'email_bounced')::int bounced,
           count(*) filter (where type = 'lead_unsubscribed')::int unsubscribed
    from events where source = 'instantly' and at > now() - interval '24 hours'`)) as unknown as { sent: number; bounced: number; unsubscribed: number }[];
  // Bounces past 5% hurt the mailboxes for every later email: stop and say why.
  if (day.sent >= 20 && day.bounced / day.sent > 0.05) {
    const why = `${day.bounced} bounces from ${day.sent} emails in 24 hours (over 5%)`;
    await pauseAll(why, "safety check");
    await tellOwner(
      "Paused: too many bounces",
      `<p>Sending is paused: ${esc(why)}. Nothing more goes out until you resume.</p><p><a href="${actionLink("resume")}">Resume sending</a></p>`,
    ).catch(() => {});
    log(`PAUSED by safety check: ${why}`);
  }
}

/* ── One run ────────────────────────────────────────────────────────────── */

export async function hourlyRun(budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  const lines: string[] = [];
  const log: Log = (l) => lines.push(l);
  // Seconds per step, and steps left out for lack of time. Saved after every
  // step, so a run the server cuts off still shows how far it got.
  const seconds: Record<string, number> = {};
  const skipped: string[] = [];
  const [run] = await db().insert(events).values({ source: "bot", type: "run", payload: { lines } }).returning({ id: events.id });
  const save = () => db().update(events).set({ payload: { lines, seconds, skipped } }).where(eq(events.id, run.id));
  const step = async (name: string, fn: () => Promise<unknown>) => {
    if (left(deadline) < 60_000) {
      skipped.push(name);
      return;
    }
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      log(`${name} failed: ${e instanceof Error ? e.message : e}`);
    }
    seconds[name] = Math.round((Date.now() - started) / 1000);
    await save().catch(() => {});
  };

  await step("replies", () => handleReplies(log));
  // Stopping and scheduling never reach anyone, so they run even while paused.
  await step("claimed", () => stopClaimed(log));
  await step("check-ins", () => scheduleCheckIns(log));
  await step("answered DMs", () => closeAnsweredTasks());
  const paused = await pausedState();
  if (paused.paused) {
    log(`paused (${paused.reason ?? "by owner"}): nothing pushed or drafted`);
  } else {
    await step("safety", () => healthCheck(log));
    if (!(await pausedState()).paused) {
      await step("push", () => pushDue(100, log));
      await step("follow-ups", () => backfillFollowUps(5, deadline, log));
      await step("sync follow-ups", () => syncFollowUps(200, log));
      await step("warm notes", () => draftWarmNotes(log));
      await step("write check-ins", () => writeDueCheckIns(log));
      await step("send notes", () => sendDueNotes(log));
      await step("intake", () => dailyIntake(log));
      // Agencies whose own site runs HighLevel: found once a day, then researched like the GHL list.
      await step("highlevel find", () => discoverHighLevel(log));
      // YouTube and TikTok creators: find, sort, collect details, hand over, write DMs, into GHL.
      await step("youtube details", () => enrichCreators(15, log));
      await step("youtube find", () => discoverCreators(log));
      await step("tiktok find", () => discoverTikTok(log));
      await step("youtube qualify", () => qualifyCreators(20, log));
      await step("youtube hand over", () => handOverPartners(30, log));
      await step("youtube DMs", () => queueTasks(10, log));
      await step("youtube to GHL", () => syncCreatorsToGhl(20, log));
      await step("verify", () => verifySome(50, deadline, log));
      await step("research", () => researchSome(30, deadline, log));
      await step("site contacts", () => contactsFromSites(30, log));
      await step("draft", () => draftSome(20, deadline, log));
      await step("creator emails", () => draftPartners(5, log, deadline));
    }
  }
  if (skipped.length) log(`out of time, left for next run: ${skipped.join(", ")}`);
  await save();
  return lines;
}

/* ── For the summary and the dashboard ──────────────────────────────────── */

export async function waitingDrafts() {
  return (await db().execute(sql`
    select m.id, m.hold_until, a.name agency, a.fit_score,
           case m.step when 1 then m.subject when 10 then 'warm note (opened the audit)' when 20 then 'check-in ("not now" earlier)' end subject
    from messages m join contacts c on c.id = m.contact_id join agencies a on a.id = c.agency_id
    where m.step in (1, 10, 20) and m.pushed_at is null and m.sent_at is null and m.stopped_at is null
      and (m.guardrail->>'ok')::boolean
    order by m.hold_until nulls first`)) as unknown as { id: string; subject: string; hold_until: string | null; agency: string; fit_score: number | null }[];
}

export async function stopDraft(messageId: string) {
  await db()
    .update(messages)
    .set({ stoppedAt: new Date() })
    .where(and(eq(messages.id, messageId), isNull(messages.pushedAt)));
}
