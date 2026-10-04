/**
 * Hand approved first emails to Instantly as leads in the campaign.
 *   npm run push                 (dry run: says what would go, pushes nothing)
 *   npm run push -- --go         (pushes up to --limit, default 20)
 * Only drafts that passed the check, to a valid address, never suppressed,
 * never pushed before. The campaign is a draft until activated in Instantly,
 * so pushing is not sending. Prints counts and agency names only.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { messages, suppression } from "../src/db/schema";
import { env } from "../src/env";
import { addLeads, blockList, bodyHtml } from "../src/lib/instantly";

const go = process.argv.includes("--go");
const i = process.argv.indexOf("--limit");
const limit = i > 0 ? Number(process.argv[i + 1]) || 20 : 20;

async function main() {
  const campaignId = env.INSTANTLY_CAMPAIGN_ID;
  if (!campaignId) throw new Error("INSTANTLY_CAMPAIGN_ID is not set: run npm run instantly:setup first.");

  const ready = (await db().execute(sql`
    select m.id, m.subject, m.body, c.email, c.first_name, c.last_name, a.name agency, a.website
    from messages m
    join contacts c on c.id = m.contact_id
    join agencies a on a.id = c.agency_id
    where m.step = 1 and m.pushed_at is null and m.sent_at is null
      and (m.guardrail->>'ok')::boolean
      and c.email_status = 'valid' and a.status = 'queued'
      and not exists (select 1 from suppression s where s.email = c.email or s.domain = a.domain)
    order by m.created_at
    limit ${limit}`)) as unknown as {
    id: string;
    subject: string;
    body: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    agency: string;
    website: string | null;
  }[];

  for (const r of ready) console.log(`${go ? "push" : "would push"}  ${r.agency}`);
  if (!go || ready.length === 0) {
    console.log(`\n${ready.length} ready.${go ? "" : " Dry run: add --go to push."}`);
    process.exit(0);
  }

  // Our suppression list goes to Instantly first, so it can never send to them either.
  const blocked = await db().select({ email: suppression.email, domain: suppression.domain }).from(suppression);
  await blockList(blocked.map((b) => b.email ?? b.domain).filter((v): v is string => !!v));

  const res = await addLeads(
    campaignId,
    ready.map((r) => ({
      email: r.email,
      first_name: r.first_name ?? undefined,
      last_name: r.last_name ?? undefined,
      company_name: r.agency,
      website: r.website ?? undefined,
      custom_variables: { subject: r.subject, body_html: bodyHtml(r.body), message_id: r.id },
    })),
  );

  const now = new Date();
  for (const lead of res.created_leads ?? []) {
    const r = ready[lead.index];
    if (!r) continue;
    await db()
      .update(messages)
      .set({ instantlyCampaignId: campaignId, instantlyLeadId: lead.id, pushedAt: now })
      .where(eq(messages.id, r.id));
  }
  console.log(
    `\n${ready.length} sent to Instantly: ${res.leads_uploaded ?? 0} added, ${res.skipped_count ?? 0} skipped (already in workspace), ` +
      `${res.in_blocklist ?? 0} blocked, ${res.duplicated_leads ?? 0} duplicates.`,
  );
  process.exit(0);
}
main();
