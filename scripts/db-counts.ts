/** Row counts per table and status (no personal data). Run: npm run db:counts */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";

async function main() {
  const rows = await db().execute(sql`
    select 'agencies' t, count(*)::int n from agencies union all
    select 'agencies: ' || status, count(*)::int from agencies group by status union all
    select 'agencies: fit 60+', count(*)::int from agencies where fit_score >= 60 union all
    select 'research versions', count(*)::int from agency_research union all
    select 'contacts', count(*)::int from contacts union all
    select 'contacts: ' || email_status, count(*)::int from contacts group by email_status union all
    select 'sendable (valid + agency researched)', count(*)::int from contacts c join agencies a on a.id = c.agency_id
      where c.email_status = 'valid' and a.status = 'researched' union all
    select 'drafts: unsent', count(*)::int from messages where sent_at is null union all
    select 'drafts: passed check', count(*)::int from messages where sent_at is null and (guardrail->>'ok')::boolean union all
    select 'drafts: pushed to Instantly', count(*)::int from messages where pushed_at is not null union all
    select 'emails sent', count(*)::int from messages where sent_at is not null union all
    select 'replies', count(*)::int from replies union all
    select 'samples', count(*)::int from samples union all
    select 'suppression', count(*)::int from suppression`);
  for (const r of rows as unknown as { t: string; n: number }[]) console.log(`${r.t.padEnd(38)} ${r.n}`);
  process.exit(0);
}
main();
