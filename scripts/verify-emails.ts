/**
 * Verify contacts' email addresses with Instantly (one credit each).
 *   npm run verify:emails -- --limit 5
 * Skips addresses GHL already marked invalid. Prints totals only.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { contacts } from "../src/db/schema";
import { verificationStatus, verifyEmail, type Verified } from "../src/lib/instantly";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) || 5 : 5;

async function main() {
  const todo = await db()
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.emailStatus, "unverified")))
    .orderBy(asc(contacts.createdAt))
    .limit(limit);

  const tally: Record<Verified | "error", number> = { valid: 0, risky: 0, invalid: 0, pending: 0, error: 0 };
  const pending: { id: string; email: string }[] = [];
  for (const c of todo) {
    try {
      const v = await verifyEmail(c.email);
      tally[v]++;
      if (v === "pending") pending.push(c);
      else await db().update(contacts).set({ emailStatus: v, updatedAt: new Date() }).where(eq(contacts.id, c.id));
    } catch (e) {
      tally.error++;
      const why = e instanceof Error ? e.message : String(e);
      // No credits will not fix itself mid-run: stop and say so.
      if (/no credits/i.test(why)) {
        console.log(`Stopped: ${why}. Add verification credits in Instantly and run again.`);
        break;
      }
    }
  }
  // Slow mail servers come back "pending"; one more look after a pause.
  if (pending.length) {
    await new Promise((r) => setTimeout(r, 15_000));
    for (const c of pending) {
      try {
        const v = await verificationStatus(c.email);
        if (v !== "pending") {
          tally.pending--;
          tally[v]++;
          await db().update(contacts).set({ emailStatus: v, updatedAt: new Date() }).where(eq(contacts.id, c.id));
        }
      } catch {
        // stays unverified; the next run asks again
      }
    }
  }
  console.log(`Checked ${todo.length}:`, JSON.stringify(tally));
  process.exit(0);
}
main();
