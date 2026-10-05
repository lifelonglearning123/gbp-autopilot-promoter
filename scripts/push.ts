/**
 * Hand approved emails to Instantly as leads in the campaign — the same step
 * the hourly run takes (src/lib/pipeline.ts pushDue): passed the check, hold
 * ended, not stopped, valid address, never suppressed, with all four emails.
 *   npm run push                 (dry run: how many are due)
 *   npm run push -- --go         (pushes up to --limit, default 20)
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { pushDue } from "../src/lib/pipeline";

const go = process.argv.includes("--go");
const i = process.argv.indexOf("--limit");
const limit = i > 0 ? Number(process.argv[i + 1]) || 20 : 20;

async function main() {
  if (go) {
    const n = await pushDue(limit, console.log);
    console.log(`${n} pushed.`);
  } else {
    const [r] = (await db().execute(sql`
      select count(*)::int n from messages m
      where m.step = 1 and m.pushed_at is null and m.stopped_at is null and (m.guardrail->>'ok')::boolean
        and (m.hold_until is null or m.hold_until <= now())`)) as unknown as { n: number }[];
    console.log(`${r.n} due. Dry run: add --go to push.`);
  }
  process.exit(0);
}
main();
