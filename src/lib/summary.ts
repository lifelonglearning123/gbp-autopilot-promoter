import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { env } from "@/env";
import { pausedState } from "./control";
import { actionLink } from "./links";
import { esc } from "./notify";
import { waitingDrafts } from "./pipeline";

/**
 * What happened in the last 24 hours and what goes next, for the owner:
 * the daily email and the dashboard read the same numbers.
 */

export async function dayNumbers() {
  const [n] = (await db().execute(sql`
    select
      (select count(*) from messages where sent_at > now() - interval '24 hours')::int sent,
      (select count(*) from messages where pushed_at > now() - interval '24 hours')::int pushed,
      (select count(*) from replies where received_at > now() - interval '24 hours')::int replies,
      (select count(*) from replies where received_at > now() - interval '24 hours' and classification = 'interested')::int interested,
      (select count(*) from replies where received_at > now() - interval '24 hours' and classification = 'remove')::int removes,
      (select count(*) from events where source = 'instantly' and type = 'email_bounced' and at > now() - interval '24 hours')::int bounced,
      (select count(*) from events where source = 'platform' and type = 'sample.viewed' and at > now() - interval '24 hours')::int viewed,
      (select count(*) from events where source = 'platform' and type = 'agency.signed_up' and at > now() - interval '24 hours')::int signups,
      (select count(*) from messages where pushed_at is not null)::int total_pushed,
      (select count(*) from messages where sent_at is not null)::int total_sent,
      (select count(*) from replies)::int total_replies,
      (select count(*) from agencies where status in ('claimed', 'customer'))::int total_signups,
      (select count(*) from messages where pushed_at is null and not coalesce((guardrail->>'ok')::boolean, false) and stopped_at is null)::int needs_review,
      (select count(*) from agencies where status = 'new')::int to_research,
      (select count(*) from creators where channel_id not like 'tiktok:%')::int yt_found,
      (select count(*) from creators where channel_id like 'tiktok:%')::int tt_found,
      (select count(*) from creators where channel_id like 'tiktok:%' and created_at > now() - interval '24 hours')::int tt_new,
      (select count(*) from creators where channel_id not like 'tiktok:%' and created_at > now() - interval '24 hours')::int yt_new,
      (select count(*) from creators where kind in ('agency', 'educator', 'audience') and status <> 'skipped')::int yt_partners,
      (select count(*) from messages m join contacts c on c.id = m.contact_id where c.source like 'partner:%' and m.step = 1 and m.pushed_at is not null)::int partners_emailed,
      (select count(*) from outreach_tasks where done_at is null and skipped_at is null and replied_at is null and due_at <= now())::int dms_due,
      (select count(*) from outreach_tasks where done_at > now() - interval '24 hours')::int dms_sent`)) as unknown as Record<string, number>[];
  return n;
}

export async function recentProblems(): Promise<string[]> {
  const runs = (await db().execute(sql`
    select payload->'lines' lines from events where source = 'bot' and type = 'run' and at > now() - interval '24 hours'`)) as unknown as { lines: string[] | null }[];
  return [...new Set(runs.flatMap((r) => r.lines ?? []).filter((l) => /failed|PAUSED/.test(l)))].slice(0, 10);
}

export async function dailySummaryHtml(): Promise<{ subject: string; html: string }> {
  const n = await dayNumbers();
  const paused = await pausedState();
  const next = (await waitingDrafts()).filter((d) => !d.hold_until || new Date(d.hold_until).getTime() < Date.now() + 24 * 3_600_000);
  const problems = await recentProblems();
  const dash = `${(env.APP_URL ?? "").replace(/\/$/, "")}/dashboard`;
  const row = (label: string, v: number | string) => `<tr><td style="padding:2px 16px 2px 0;color:#555">${label}</td><td><b>${v}</b></td></tr>`;

  const status = paused.paused
    ? `<p style="background:#fff4e5;padding:10px">⏸ <b>Paused</b> — ${esc(paused.reason ?? "by you")}. Nothing is being sent. <a href="${actionLink("resume")}">Resume</a></p>`
    : `<p style="background:#eefaf1;padding:10px">▶ <b>Running.</b> <a href="${actionLink("pause")}">Pause everything</a></p>`;

  const nextList = next.length
    ? `<ol>${next
        .slice(0, 40)
        .map((d) => `<li>${esc(d.agency)} — “${esc(d.subject)}” · <a href="${actionLink("stop", d.id)}">stop this one</a></li>`)
        .join("")}</ol>${next.length > 40 ? `<p>…and ${next.length - 40} more on the dashboard.</p>` : ""}`
    : "<p>None.</p>";

  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
  <h2 style="margin:0 0 8px">GBP Autopilot outreach — daily summary</h2>
  ${status}
  <h3>Last 24 hours</h3>
  <table>${row("Emails sent", n.sent)}${row("Replies", `${n.replies} (${n.interested} interested, ${n.removes} asked to be removed)`)}${row("Bounces", n.bounced)}${row("Audits viewed", n.viewed)}${row("Sign-ups", n.signups)}${row("Added to the campaign", n.pushed)}</table>
  <h3>So far</h3>
  <table>${row("In the campaign", n.total_pushed)}${row("Sent", n.total_sent)}${row("Replies", n.total_replies)}${row("Signed up", n.total_signups)}${row("Agencies still to research", n.to_research)}${row("Drafts that failed the check (not sent)", n.needs_review)}</table>
  <h3>YouTube and TikTok creators</h3>
  <table>${row("YouTube channels found (new in 24h)", `${n.yt_found} (${n.yt_new})`)}${row("TikTok accounts found (new in 24h)", `${n.tt_found} (${n.tt_new})`)}${row("Creators for the creator offer (free white-label, 40% for life)", n.yt_partners)}${row("Creators emailed so far", n.partners_emailed)}${row("DMs and calls due now", n.dms_due)}${row("DMs sent in 24h", n.dms_sent)}</table>
  ${n.dms_due ? `<p><a href="${dash.replace(/\/dashboard$/, "/queue")}">Open the DM queue (${n.dms_due} due)</a></p>` : ""}
  <h3>Going out next (${next.length})</h3>
  <p style="color:#555">These go into the campaign once their 24-hour hold ends, unless you stop them.</p>
  ${nextList}
  ${problems.length ? `<h3>Problems</h3><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
  <p><a href="${dash}">Open the dashboard</a></p>
</div>`;
  const subject = `${paused.paused ? "⏸ Paused · " : ""}Outreach: ${n.sent} sent, ${n.replies} replies, ${next.length} going out next`;
  return { subject, html };
}

/* ── Weekly results ─────────────────────────────────────────────────────── */

export type ResultRow = {
  label: string;
  emailed: number;
  opened: number;
  replied: number;
  interested: number;
  not_now: number;
  removed: number;
  bounced: number;
  signed_up: number;
};

/**
 * What became of everyone we emailed, grouped by the week their first email
 * went, and over the last eight weeks by campaign, by where the lead came from
 * and by the kind of audit they got. Each person counts once per column
 * (opened, replied...), whenever it happened, so a week's row keeps filling in
 * as replies come back.
 */
export async function weeklyResults(): Promise<{
  weeks: (ResultRow & { sent_all: number })[];
  campaigns: ResultRow[];
  origins: ResultRow[];
  audits: ResultRow[];
}> {
  const has = (type: string) => sql`exists (select 1 from events e where e.contact_id = c.id and e.type = ${type})`;
  const replied = (kind?: string) =>
    kind
      ? sql`exists (select 1 from replies r where r.contact_id = c.id and r.classification = ${kind})`
      : sql`exists (select 1 from replies r where r.contact_id = c.id)`;
  const base = sql`
    with first as (
      select distinct on (m.contact_id) m.contact_id, m.sent_at, m.instantly_campaign_id
      from messages m where m.step = 1 and m.sent_at is not null
      order by m.contact_id, m.sent_at
    ), base as (
      select f.sent_at,
        to_char(date_trunc('week', f.sent_at), 'YYYY-MM-DD') wk,
        case when c.source like 'partner:%' or c.source like 'youtube:%' then 'Creators'
             when f.instantly_campaign_id = ${env.INSTANTLY_US_CAMPAIGN_ID ?? "-"} then 'US agencies ($199)'
             else 'UK agencies (£149)' end campaign,
        case when c.source like 'partner:%' or c.source like 'youtube:%' then 'Creators (YouTube / TikTok)'
             when c.source like 'highlevel:%' or c.source like 'site:%' then 'Found by us (HighLevel finder, own site)'
             else 'GHL list' end origin,
        coalesce((select s.kind from samples s where s.contact_id = c.id order by s.created_at desc limit 1), 'none') audit_kind,
        ${has("sample.viewed")} opened,
        ${replied()} replied,
        ${replied("interested")} interested,
        ${replied("not_now")} not_now,
        (${replied("remove")} or ${has("lead_unsubscribed")}) removed,
        ${has("email_bounced")} bounced,
        (a.status in ('claimed', 'customer') or ${has("agency.signed_up")}) signed_up
      from first f join contacts c on c.id = f.contact_id join agencies a on a.id = c.agency_id
      where f.sent_at > now() - interval '8 weeks'
    )`;
  const cols = sql`count(*)::int emailed, count(*) filter (where opened)::int opened, count(*) filter (where replied)::int replied,
    count(*) filter (where interested)::int interested, count(*) filter (where not_now)::int not_now,
    count(*) filter (where removed)::int removed, count(*) filter (where bounced)::int bounced, count(*) filter (where signed_up)::int signed_up`;
  const by = async (dim: "wk" | "campaign" | "origin" | "audit_kind") =>
    (await db().execute(
      sql`${base} select ${sql.raw(dim)} label, ${cols} from base group by 1 order by 1 ${sql.raw(dim === "wk" ? "desc" : "")}`,
    )) as unknown as ResultRow[];
  const AUDIT: Record<string, string> = {
    own: "Audit of their own listing",
    client: "Audit of a client's listing",
    prospect: "Audit of a local business",
    none: "No audit (claim link only)",
  };
  const [weeks, campaigns, origins, audits, sent] = await Promise.all([
    by("wk"),
    by("campaign"),
    by("origin"),
    by("audit_kind"),
    db().execute(sql`
      select to_char(date_trunc('week', sent_at), 'YYYY-MM-DD') wk, count(*)::int n
      from messages where sent_at > now() - interval '8 weeks' group by 1`) as unknown as Promise<{ wk: string; n: number }[]>,
  ]);
  const sentBy = new Map(sent.map((s) => [s.wk, s.n]));
  return {
    weeks: weeks.map((w) => ({ ...w, label: `Week of ${w.label}`, sent_all: sentBy.get(w.label) ?? 0 })),
    campaigns,
    origins,
    audits: audits.map((a) => ({ ...a, label: AUDIT[a.label] ?? a.label })),
  };
}

/** The weekly results as tables: the dashboard shows them, and Monday's email carries them. */
export async function weeklyResultsHtml(): Promise<string> {
  const r = await weeklyResults();
  if (!r.weeks.length) return "<p>No first emails sent in the last eight weeks.</p>";
  const pct = (n: number, of: number) => (of && n ? `${n} <span style="color:#777">(${Math.round((n / of) * 100)}%)</span>` : `${n}`);
  const th = (s: string) => `<th style="text-align:left;padding:4px 10px 4px 0;font-weight:600;color:#555;border-bottom:1px solid #ddd">${s}</th>`;
  const td = (s: string | number) => `<td style="padding:4px 10px 4px 0;border-bottom:1px solid #f0f0f0">${s}</td>`;
  const table = (title: string, rows: (ResultRow & { sent_all?: number })[], first: string, withSent = false) =>
    rows.length
      ? `<h3 style="margin:18px 0 6px">${title}</h3><table style="border-collapse:collapse;font-size:14px">
          <tr>${th(first)}${withSent ? th("Emails sent (all steps)") : ""}${th("Emailed")}${th("Opened audit")}${th("Replied")}${th("Interested")}${th("Not now")}${th("Removed")}${th("Bounced")}${th("Signed up")}</tr>
          ${rows
            .map(
              (x) =>
                `<tr>${td(esc(x.label))}${withSent ? td(x.sent_all ?? 0) : ""}${td(x.emailed)}${td(pct(x.opened, x.emailed))}${td(pct(x.replied, x.emailed))}${td(x.interested)}${td(x.not_now)}${td(x.removed)}${td(pct(x.bounced, x.emailed))}${td(pct(x.signed_up, x.emailed))}</tr>`,
            )
            .join("")}
        </table>`
      : "";
  return `<p style="color:#555;margin:0">Everyone whose first email went in the last eight weeks, and what they have done since. Rows keep filling in as people answer.</p>
    ${table("By week the first email went", r.weeks, "Week", true)}
    ${table("By campaign", r.campaigns, "Campaign")}
    ${table("By where the lead came from", r.origins, "Source")}
    ${table("By the audit they got", r.audits, "Audit")}`;
}
