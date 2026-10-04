/**
 * Research agencies that have not been researched yet.
 *   npm run research -- --limit 5
 *   npm run research -- --limit 2000 --parallel 4
 * Safe to stop and start: it only picks agencies still marked "new".
 * Prints a line per agency (agency names only, no contacts), then the model cost.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { agencies } from "../src/db/schema";
import { researchAgency } from "../src/lib/research";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) || fallback : fallback;
};
const limit = arg("--limit", 5);
const parallel = Math.max(1, Math.min(8, arg("--parallel", 1)));

async function main() {
  const todo = await db()
    .select({ id: agencies.id, name: agencies.name })
    .from(agencies)
    .where(eq(agencies.status, "new"))
    .orderBy(asc(agencies.createdAt))
    .limit(limit);
  let cost = 0;
  let done = 0;
  const tally: Record<string, number> = {};
  const queue = [...todo];

  async function worker() {
    for (let a = queue.shift(); a; a = queue.shift()) {
      let line: string;
      try {
        const r = await researchAgency(a.id);
        if (r.ok) {
          cost += r.costUsd ?? 0;
          tally[r.status] = (tally[r.status] ?? 0) + 1;
          line = `${String(r.fitScore).padStart(3)}  ${r.status.padEnd(10)} ${a.name}`;
        } else {
          tally[r.why] = (tally[r.why] ?? 0) + 1;
          line = `  -  ${r.why.padEnd(10)} ${a.name}`;
        }
      } catch (e) {
        tally.error = (tally.error ?? 0) + 1;
        line = `  !  error      ${a.name}: ${e instanceof Error ? e.message : e}`;
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
