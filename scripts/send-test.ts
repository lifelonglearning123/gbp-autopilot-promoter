/**
 * Send one real draft, exactly as the campaign would, to an address of ours.
 * Makes a separate one-lead campaign ("TEST (internal)") with the main
 * campaign's email and one of our mailboxes, sending any day and hour, and
 * activates it. The main campaign is not touched.
 *   npm run send-test -- you@example.com
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { env } from "../src/env";
import { addLeads, bodyHtml, ourTagId, sendingAccounts, tagCampaign } from "../src/lib/instantly";

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
  if (!to || !to.includes("@")) throw new Error("Give the address to send the test to.");
  if (!env.INSTANTLY_CAMPAIGN_ID) throw new Error("No INSTANTLY_CAMPAIGN_ID.");

  const main = await call<{ sequences: { steps: { variants: { body: string }[] }[] }[] }>("GET", `/campaigns/${env.INSTANTLY_CAMPAIGN_ID}`);
  const body = main.sequences[0].steps[0].variants[0].body;

  const [draft] = (await db().execute(sql`
    select m.subject, m.body, a.name from messages m
    join contacts c on c.id = m.contact_id join agencies a on a.id = c.agency_id
    where m.pushed_at is not null order by m.created_at limit 1`)) as unknown as { subject: string; body: string; name: string }[];
  if (!draft) throw new Error("No pushed draft to test with.");

  const tagId = await ourTagId();
  const [mailbox] = await sendingAccounts(tagId);
  const all = { "0": true, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true };
  const c = await call<{ id: string }>("POST", "/campaigns", {
    name: `GBP Autopilot — TEST (internal) ${new Date().toISOString().slice(0, 16)}`,
    campaign_schedule: { schedules: [{ name: "any time", timing: { from: "00:00", to: "23:59" }, days: all, timezone: "Europe/Isle_of_Man" }] },
    sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: "{{subject}}", body }] }] }],
    email_list: [mailbox],
    daily_limit: 5,
    stop_on_reply: true,
    open_tracking: false,
    link_tracking: false,
  });
  await tagCampaign(tagId, c.id);
  await addLeads(c.id, [
    { email: to, first_name: "Chao", company_name: draft.name, custom_variables: { subject: draft.subject, body_html: bodyHtml(draft.body), message_id: "test" } },
  ]);
  await call("POST", `/campaigns/${c.id}/activate`);
  console.log(`Test campaign ${c.id} active: the ${draft.name} draft goes to ${to} from ${mailbox.split("@")[0]}@…`);
  process.exit(0);
}
main();
