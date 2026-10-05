/**
 * Rewrite first emails that are in Instantly but not yet sent (after the
 * offer's wording changed), and put the new text on each Instantly lead.
 *   npm run rewrite-first -- --parallel 4
 * Asks Instantly which first emails have gone, and records those as sent
 * (sends before the webhook existed were never recorded). Prints counts and
 * agency names only.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { contacts, messages } from "../src/db/schema";
import { env } from "../src/env";
import { rewriteFirstEmail } from "../src/lib/draft";
import { followUpVars } from "../src/lib/followups";
import { bodyHtml, setLeadVars } from "../src/lib/instantly";

const H = { Authorization: `Bearer ${env.INSTANTLY_API_KEY}` };
const i = process.argv.indexOf("--parallel");
const parallel = Math.max(1, Math.min(6, i > 0 ? Number(process.argv[i + 1]) || 4 : 4));

/** Who has had an email from the campaign, and when (Instantly's sent mail). */
async function sentSoFar(campaignId: string): Promise<Map<string, string>> {
  const sent = new Map<string, string>();
  let after: string | undefined;
  do {
    const url = `https://api.instantly.ai/api/v2/emails?campaign_id=${campaignId}&email_type=sent&limit=100${after ? `&starting_after=${after}` : ""}`;
    const r = (await (await fetch(url, { headers: H })).json()) as {
      items?: { to_address_email_list?: string; timestamp_email?: string; timestamp_created?: string }[];
      next_starting_after?: string;
    };
    for (const e of r.items ?? []) {
      for (const to of String(e.to_address_email_list ?? "").split(",")) {
        const k = to.trim().toLowerCase();
        if (k && !sent.has(k)) sent.set(k, e.timestamp_email ?? e.timestamp_created ?? new Date().toISOString());
      }
    }
    after = r.next_starting_after;
  } while (after);
  return sent;
}

async function main() {
  const campaignId = env.INSTANTLY_CAMPAIGN_ID!;
  const sent = await sentSoFar(campaignId);

  // Record the sends the webhook missed.
  let recorded = 0;
  for (const [email, at] of sent) {
    const [c] = await db().select({ id: contacts.id }).from(contacts).where(eq(contacts.email, email)).limit(1);
    if (!c) continue;
    const r = await db()
      .update(messages)
      .set({ sentAt: new Date(at) })
      .where(and(eq(messages.contactId, c.id), eq(messages.step, 1), isNull(messages.sentAt)))
      .returning({ id: messages.id });
    recorded += r.length;
  }
  console.log(`Instantly has sent to ${sent.size}; ${recorded} newly recorded as sent.`);

  const todo = (await db().execute(sql`
    select m.id, m.contact_id, m.instantly_lead_id, a.name from messages m
    join contacts c on c.id = m.contact_id join agencies a on a.id = c.agency_id
    where m.step = 1 and m.pushed_at is not null and m.sent_at is null and m.instantly_lead_id is not null`)) as unknown as {
    id: string;
    contact_id: string;
    instantly_lead_id: string;
    name: string;
  }[];
  const queue = [...todo];
  const tally: Record<string, number> = {};
  let done = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        let line: string;
        try {
          const r = await rewriteFirstEmail(t.id);
          if (r.ok) {
            const [m] = await db().select().from(messages).where(eq(messages.id, t.id)).limit(1);
            const follow = (await followUpVars(t.contact_id, bodyHtml)) ?? {};
            await setLeadVars(t.instantly_lead_id, { subject: m.subject ?? "", body_html: bodyHtml(m.body), message_id: m.id, ...follow });
          }
          const k = r.ok ? "rewritten" : r.why?.startsWith("kept") ? "kept old" : (r.why ?? "failed");
          tally[k] = (tally[k] ?? 0) + 1;
          line = `${k.padEnd(10)} ${t.name}`;
        } catch (e) {
          tally.error = (tally.error ?? 0) + 1;
          line = `error      ${t.name}: ${e instanceof Error ? e.message : e}`;
        }
        console.log(`[${++done}/${todo.length}] ${line}`);
      }
    }),
  );
  console.log(`\n${todo.length} unsent first emails:`, JSON.stringify(tally));
  process.exit(0);
}
main();
