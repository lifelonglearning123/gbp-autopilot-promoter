/**
 * Draft first emails (unsent) for researched agencies.
 *   npm run draft -- --limit 3
 *   npm run draft -- --limit 50 --parallel 3
 *   npm run draft -- --redo          (re-write drafts not yet pushed to Instantly)
 *   npm run draft -- --redo-failed   (only the ones the checker did not pass)
 *   npm run draft -- --retry-no-sample (agencies set aside because no audit could be made)
 * One contact per agency: a valid address, work email first, nothing drafted
 * yet, not suppressed. Each run asks the platform for a real sample audit.
 * Prints agency names and outcomes only; read the drafts with npm run drafts:review.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { draftFirstEmail } from "../src/lib/draft";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) || fallback : fallback;
};
const limit = arg("--limit", 3);
const parallel = Math.max(1, Math.min(4, arg("--parallel", 1)));

async function main() {
  // --redo: agencies whose draft Instantly has not been given are drafted again.
  // The old draft is replaced only once the new one is saved.
  const failedOnly = process.argv.includes("--redo-failed");
  const redo = failedOnly || process.argv.includes("--redo");
  const retryNoSample = process.argv.includes("--retry-no-sample");
  const todo = (await db().execute(sql`
    select distinct on (a.id) c.id, a.name
    from agencies a join contacts c on c.agency_id = a.id
    where c.email_status = 'valid'
      and (a.status = 'researched' or (${retryNoSample} and a.status = 'no_sample') or (${redo} and (a.status = 'needs_review' or (${!failedOnly} and a.status = 'queued'))))
      and not exists (select 1 from messages m join contacts c2 on c2.id = m.contact_id
                      where c2.agency_id = a.id and (m.pushed_at is not null or not ${redo}))
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    order by a.id, (c.email_type = 'work') desc, c.created_at
    limit ${limit}`)) as unknown as { id: string; name: string }[];

  let cost = 0;
  let done = 0;
  const tally: Record<string, number> = {};
  const queue = [...todo];

  async function worker() {
    for (let t = queue.shift(); t; t = queue.shift()) {
      let line: string;
      try {
        const r = await draftFirstEmail(t.id);
        if (r.ok) {
          cost += r.costUsd;
          const key = r.passed ? "queued" : "needs_review";
          tally[key] = (tally[key] ?? 0) + 1;
          line = `${key.padEnd(12)} ${r.sampleKind.padEnd(6)} ${r.writer.split("/").pop()!.padEnd(8)} ${t.name}${r.passed ? "" : `  (${r.notes.join("; ")})`}`;
        } else {
          tally[r.why.split(":")[0]] = (tally[r.why.split(":")[0]] ?? 0) + 1;
          line = `-            ${t.name}: ${r.why}`;
        }
      } catch (e) {
        tally.error = (tally.error ?? 0) + 1;
        line = `! error      ${t.name}: ${e instanceof Error ? e.message : e}`;
      }
      done++;
      console.log(`[${done}/${todo.length}] ${line}`);
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  console.log(`\n${todo.length} agencies, model cost $${cost.toFixed(4)}`, JSON.stringify(tally));
  process.exit(0);
}
main();
