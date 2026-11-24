/**
 * Research agencies that have not been researched yet, on the local model
 * (Ollama on this PC, no cost). The PC's idle task runs it; the Vercel cron
 * leaves new agencies for it while RESEARCH_ON is "local".
 *   npm run research -- --limit 5
 *   npm run research -- --limit 200 --minutes 600     (the idle task)
 *   npm run research -- --limit 5 --kimi              (Kimi instead, costs money)
 * Safe to stop and start: it only picks agencies still marked "new".
 * 40+ is researched (drafted next), 30-39 parked for later, the rest skipped.
 * Prints a line per agency (agency names only, no contacts), then the model cost.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { agencies } from "../src/db/schema";
import { startOllama } from "../src/lib/ollama";
import { researchAgency } from "../src/lib/research";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) || fallback : fallback;
};
const limit = arg("--limit", 5);
const kimi = process.argv.includes("--kimi");
// The local model answers one at a time; more in parallel only queue up.
const parallel = kimi ? Math.max(1, Math.min(8, arg("--parallel", 1))) : 1;
const until = Date.now() + arg("--minutes", 600) * 60_000;

async function main() {
  if (!kimi && !(await startOllama())) {
    console.log("Ollama would not start; nothing researched.");
    process.exit(1);
  }
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
    for (let a = queue.shift(); a && Date.now() < until; a = queue.shift()) {
      let line: string;
      try {
        const r = await researchAgency(a.id, { local: !kimi });
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
