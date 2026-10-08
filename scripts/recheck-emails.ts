/**
 * Addresses that GHL's own check passed (or called risky) but that we have not
 * written to yet go back for Instantly's verification (the owner's rule,
 * 2026-10-08), which the hourly run then does 50 at a time and tags in GHL.
 * Anyone already emailed keeps their status.
 *   npm run recheck:emails            (how many)
 *   npm run recheck:emails -- --write (send them back)
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";

const WHERE = sql`
  c.email_status in ('valid', 'risky')
  and not exists (select 1 from messages m where m.contact_id = c.id and (m.pushed_at is not null or m.sent_at is not null))
  and not exists (select 1 from events e where e.contact_id = c.id and e.type = 'email.checked')`;

async function main() {
  const rows = (await db().execute(sql`select c.email_status s, count(*)::int n from contacts c where ${WHERE} group by 1`)) as unknown as { s: string; n: number }[];
  console.log("Not yet emailed, not yet checked by Instantly:", rows.map((r) => `${r.s} ${r.n}`).join(", ") || "none");
  if (!process.argv.includes("--write")) {
    console.log("Nothing changed. Run with --write to send them for checking.");
    process.exit(0);
  }
  const done = (await db().execute(sql`update contacts c set email_status = 'unverified', updated_at = now() where ${WHERE} returning c.id`)) as unknown[];
  console.log(`${done.length} addresses go to Instantly's verification over the next hourly runs.`);
  process.exit(0);
}
main();
