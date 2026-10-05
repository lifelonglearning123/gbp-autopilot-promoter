/**
 * Send one real lead's emails, exactly as the campaign would, to an address of
 * ours. Makes a separate one-lead campaign ("TEST (internal)") with one of our
 * mailboxes, sending any day and hour, and activates it. The main campaign is
 * not touched.
 *   npm run send-test -- you@example.com              the first email only
 *   npm run send-test -- you@example.com --sequence   all four, minutes apart (3, 4, 7)
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { env } from "../src/env";
import { followUpVars } from "../src/lib/followups";
import { addLeads, bodyHtml, ourTagId, sendingAccounts, sequenceSteps, tagCampaign } from "../src/lib/instantly";

const B = "https://api.instantly.ai/api/v2";
const H = { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "Content-Type": "application/json" };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${B}${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`Instantly ${method} ${path} ${res.status}: ${data.message ?? ""}`);
  return data;
}

async function main() {
  const to = process.argv[2]?.trim().toLowerCase();
  const whole = process.argv.includes("--sequence");
  if (!to || !to.includes("@")) throw new Error("Give the address to send the test to.");
  if (!env.SENDER_LEGAL) throw new Error("SENDER_LEGAL is not set.");

  const [draft] = (await db().execute(sql`
    select m.id, m.contact_id, m.subject, m.body, a.name from messages m
    join contacts c on c.id = m.contact_id join agencies a on a.id = c.agency_id
    where m.step = 1 and m.pushed_at is not null
      and (${!whole} or exists (select 1 from messages f where f.contact_id = m.contact_id and f.step = 4))
    order by m.created_at limit 1`)) as unknown as { id: string; contact_id: string; subject: string; body: string; name: string }[];
  if (!draft) throw new Error(whole ? "No pushed lead has follow-ups yet." : "No pushed draft to test with.");
  const followUps = whole ? await followUpVars(draft.contact_id, bodyHtml) : {};

  const lines = (s: string) => s.replace(/\\n/g, "\n");
  const steps = sequenceSteps(lines(env.SENDER_SIGNOFF), lines(env.SENDER_LEGAL), "minutes");
  const tagId = await ourTagId();
  const [mailbox] = await sendingAccounts(tagId);
  const all = { "0": true, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true };
  const c = await call<{ id: string }>("POST", "/campaigns", {
    name: `GBP Autopilot — TEST (internal) ${new Date().toISOString().slice(0, 16)}`,
    campaign_schedule: { schedules: [{ name: "any time", timing: { from: "00:00", to: "23:59" }, days: all, timezone: "Europe/Isle_of_Man" }] },
    sequences: [{ steps: whole ? steps : [{ ...steps[0], delay: 0 }] }],
    email_list: [mailbox],
    daily_limit: 10,
    stop_on_reply: true,
    open_tracking: false,
    link_tracking: false,
  });
  await tagCampaign(tagId, c.id);
  await addLeads(c.id, [
    {
      email: to,
      first_name: "Chao",
      company_name: draft.name,
      custom_variables: { subject: draft.subject, body_html: bodyHtml(draft.body), message_id: "test", ...followUps },
    },
  ]);
  await call("POST", `/campaigns/${c.id}/activate`);
  console.log(`Test campaign ${c.id} active: the ${draft.name} ${whole ? "sequence (4 emails, minutes apart)" : "first email"} goes to ${to}.`);
  process.exit(0);
}
main();
