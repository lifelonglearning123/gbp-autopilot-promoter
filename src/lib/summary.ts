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
      (select count(*) from creators)::int yt_found,
      (select count(*) from creators where created_at > now() - interval '24 hours')::int yt_new,
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
  <h3>YouTube creators</h3>
  <table>${row("Channels found (new in 24h)", `${n.yt_found} (${n.yt_new})`)}${row("Creators for the creator offer (free white-label, 40% for life)", n.yt_partners)}${row("Creators emailed so far", n.partners_emailed)}${row("DMs and calls due now", n.dms_due)}${row("DMs sent in 24h", n.dms_sent)}</table>
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
