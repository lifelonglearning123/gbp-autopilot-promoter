import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, controls, events } from "@/db/schema";
import { REFUSAL_FRESH_HOURS } from "./failure-rules";
import { esc, tellOwner } from "./notify";

/**
 * Remembering that the model provider refused the account, and setting aside
 * what failed on its own account (failure-rules.ts says which is which).
 */

export type Refusal = { at: string; step: string; message: string };

const KEY = "model_refused";

/** The refusal, while it is still news; null once it has gone quiet. */
export async function currentRefusal(): Promise<Refusal | null> {
  const [row] = await db().select().from(controls).where(eq(controls.key, KEY)).limit(1);
  const r = row?.value as Refusal | undefined;
  if (!r?.at) return null;
  return Date.now() - new Date(r.at).getTime() < REFUSAL_FRESH_HOURS * 3_600_000 ? r : null;
}

/**
 * The account was refused. Kept for the dashboard and the summary, and the
 * owner is emailed the first time in a day: ten silent days is what happened
 * when it was only a line in a run's log.
 */
export async function recordRefusal(step: string, message: string): Promise<void> {
  const [row] = await db().select().from(controls).where(eq(controls.key, KEY)).limit(1);
  const before = row?.value as Refusal | undefined;
  const value: Refusal = { at: new Date().toISOString(), step, message: message.slice(0, 400) };
  await db()
    .insert(controls)
    .values({ key: KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: controls.key, set: { value, updatedAt: new Date() } });
  const told = before?.at && Date.now() - new Date(before.at).getTime() < 24 * 3_600_000;
  if (!told) {
    await tellOwner(
      "Outreach has stopped: the writing model refused our account",
      `<p>Every email draft is failing, so nothing new is being written or sent. The ${esc(step)} step was refused with:</p>
<p style="background:#fff4e5;padding:10px">${esc(value.message)}</p>
<p>This usually means the model account needs topping up, or its key has changed. Drafting starts again by itself on the next hourly run after it is fixed.</p>`,
    ).catch(() => {});
  }
}

/**
 * Set a draft that failed on its own account aside, so the queue behind it
 * moves. The agency is marked `draft_failed`, tried again after SET_ASIDE_DAYS,
 * and the reason is kept as an event.
 */
export async function setAside(contactId: string, why: string): Promise<void> {
  const [c] = await db().select({ agencyId: contacts.agencyId }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!c) return;
  await db().update(agencies).set({ status: "draft_failed", updatedAt: new Date() }).where(eq(agencies.id, c.agencyId));
  await db().insert(events).values({ contactId, agencyId: c.agencyId, source: "bot", type: "draft.failed", payload: { why: why.slice(0, 500) } });
}
