/**
 * Verify contacts' email addresses.
 *   npm run verify:emails -- --limit 5            (GHL, paid from the location wallet)
 *   npm run verify:emails -- --limit 5 --instantly (Instantly credits)
 * Skips addresses already checked or marked invalid. Prints totals only.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { contacts } from "../src/db/schema";
import { verifyEmailGhl } from "../src/lib/ghl";
import { verificationStatus, verifyEmail } from "../src/lib/instantly";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) || fallback : fallback;
};
const limit = arg("--limit", 5);
const parallel = Math.max(1, Math.min(5, arg("--parallel", 2)));
const useInstantly = process.argv.includes("--instantly");

async function check(email: string): Promise<string> {
  if (!useInstantly) return verifyEmailGhl(email);
  const v = await verifyEmail(email);
  if (v !== "pending") return v;
  await new Promise((r) => setTimeout(r, 15_000));
  return verificationStatus(email);
}

async function main() {
  const todo = await db()
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.emailStatus, "unverified"))
    .orderBy(asc(contacts.createdAt))
    .limit(limit);

  const tally: Record<string, number> = {};
  let stop: string | null = null;
  const queue = [...todo];
  async function worker() {
    for (let c = queue.shift(); c && !stop; c = queue.shift()) {
      try {
        const v = await check(c.email);
        tally[v] = (tally[v] ?? 0) + 1;
        if (v !== "pending") {
          await db().update(contacts).set({ emailStatus: v, updatedAt: new Date() }).where(eq(contacts.id, c.id));
        }
      } catch (e) {
        tally.error = (tally.error ?? 0) + 1;
        const why = e instanceof Error ? e.message : String(e);
        // Out of credit or wallet will not fix itself mid-run: stop and say so.
        if (/credit|wallet|balance|insufficient|40[23]/i.test(why)) stop = why;
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  if (stop) console.log(`Stopped early: ${stop}`);
  console.log(`Checked ${Object.values(tally).reduce((a, b) => a + b, 0)} of ${todo.length} (${useInstantly ? "Instantly" : "GHL"}):`, JSON.stringify(tally));
  process.exit(0);
}
main();
