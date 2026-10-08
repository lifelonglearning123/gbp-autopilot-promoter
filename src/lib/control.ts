import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { controls } from "@/db/schema";
import { env } from "@/env";

/**
 * The owner's switches. "Paused" stops everything that reaches anyone outside:
 * the Instantly campaign is paused and the hourly run pushes nothing. It still
 * handles replies, so a "remove" is honoured even while paused.
 */

export type Paused = { paused: boolean; reason?: string; at?: string; by?: string };

export async function pausedState(): Promise<Paused> {
  const [row] = await db().select().from(controls).where(eq(controls.key, "paused")).limit(1);
  return (row?.value as Paused | undefined) ?? { paused: false };
}

async function setPaused(value: Paused) {
  await db()
    .insert(controls)
    .values({ key: "paused", value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: controls.key, set: { value, updatedAt: new Date() } });
}

/** The agency campaigns the owner's switch covers. Creator campaigns stay as set in Instantly (activated by hand). */
async function campaign(action: "pause" | "activate") {
  if (!env.INSTANTLY_API_KEY) return;
  for (const id of [env.INSTANTLY_CAMPAIGN_ID, env.INSTANTLY_US_CAMPAIGN_ID]) {
    if (!id) continue;
    const res = await fetch(`https://api.instantly.ai/api/v2/campaigns/${id}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Instantly would not ${action} campaign ${id} (${res.status}).`);
  }
}

/** Stop sending now. Our switch is set first, so nothing is pushed even if Instantly fails. */
export async function pauseAll(reason: string, by: string) {
  await setPaused({ paused: true, reason, by, at: new Date().toISOString() });
  await campaign("pause");
}

export async function resumeAll(by: string) {
  await campaign("activate");
  await setPaused({ paused: false, by, at: new Date().toISOString() });
}
