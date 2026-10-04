/**
 * Bring what our earlier Instantly campaigns learned into suppression, so the
 * new campaign never writes to anyone who bounced, unsubscribed, asked to be
 * removed, or is on Instantly's block list. Only campaigns with our tag.
 *   npm run import:history
 * Safe to re-run. Prints counts only.
 */
import { inArray } from "drizzle-orm";
import { db } from "../src/db/client";
import { contacts, suppression } from "../src/db/schema";
import { env } from "../src/env";
import { ourTagId } from "../src/lib/instantly";

const B = "https://api.instantly.ai/api/v2";
const H = { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "Content-Type": "application/json" };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${B}${path}`, body ? { method: "POST", headers: H, body: JSON.stringify(body) } : { headers: H });
  if (!res.ok) throw new Error(`Instantly ${path.split("?")[0]} ${res.status}`);
  return res.json() as Promise<T>;
}

type Lead = { email: string; status?: number; lt_interest_status?: number | null };

async function main() {
  const tagId = await ourTagId();
  const camps = await call<{ items: { id: string; name: string }[] }>(`/campaigns?limit=100&tag_ids=${tagId}`);
  const reasons = new Map<string, string>();

  for (const c of camps.items) {
    if (c.id === env.INSTANTLY_CAMPAIGN_ID) continue;
    let after: string | undefined;
    let n = 0;
    do {
      const r = await call<{ items?: Lead[]; next_starting_after?: string }>("/leads/list", { campaign: c.id, limit: 100, starting_after: after });
      for (const l of r.items ?? []) {
        n++;
        const email = l.email.trim().toLowerCase();
        // Lead status -1 bounced, -2 unsubscribed; interest -1 not interested ("remove", "no thanks").
        if (l.status === -1) reasons.set(email, "bounced");
        else if (l.status === -2) reasons.set(email, "unsubscribed");
        else if (l.lt_interest_status === -1) reasons.set(email, "not interested (earlier campaign)");
      }
      after = r.next_starting_after;
    } while (after);
    console.log(`${c.name}: ${n} leads read`);
  }

  // Instantly's block list (shared across the workspace: an unsubscribe there applies to everyone).
  let after: string | undefined;
  let blocked = 0;
  do {
    const r = await call<{ items?: { bl_value: string; is_domain?: boolean }[]; next_starting_after?: string }>(
      `/block-lists-entries?limit=100${after ? `&starting_after=${after}` : ""}`,
    );
    for (const b of r.items ?? []) {
      blocked++;
      if (!b.is_domain) reasons.set(b.bl_value.trim().toLowerCase(), reasons.get(b.bl_value) ?? "on Instantly block list");
      else await db().insert(suppression).values({ domain: b.bl_value.toLowerCase(), reason: "on Instantly block list" }).onConflictDoNothing();
    }
    after = r.next_starting_after;
  } while (after);

  const rows = [...reasons].map(([email, reason]) => ({ email, reason }));
  for (let i = 0; i < rows.length; i += 500) {
    await db().insert(suppression).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
  const bounced = rows.filter((r) => r.reason === "bounced").map((r) => r.email);
  for (let i = 0; i < bounced.length; i += 500) {
    await db().update(contacts).set({ emailStatus: "invalid", updatedAt: new Date() }).where(inArray(contacts.email, bounced.slice(i, i + 500)));
  }
  const tally: Record<string, number> = {};
  for (const r of rows) tally[r.reason] = (tally[r.reason] ?? 0) + 1;
  const ours = await db().select({ id: contacts.id }).from(contacts).where(inArray(contacts.email, rows.length ? rows.map((r) => r.email) : [""]));
  console.log(`\nBlock list entries read: ${blocked}`);
  console.log("Suppressed:", JSON.stringify(tally), `— ${ours.length} of them are our contacts.`);
  process.exit(0);
}
main();
