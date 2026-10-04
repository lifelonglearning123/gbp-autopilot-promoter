/** Row counts per table (no personal data). Run: npx dotenv -e .env.local -- tsx scripts/db-counts.ts */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";

async function main() {
  const rows = await db().execute(sql`
    select 'agencies' t, count(*)::int n from agencies union all
    select 'contacts', count(*)::int from contacts union all
    select 'contacts: work email', count(*)::int from contacts where email_type = 'work' union all
    select 'contacts: free-mail', count(*)::int from contacts where email_type = 'free' union all
    select 'contacts: GHL-invalid', count(*)::int from contacts where email_status = 'invalid' union all
    select 'suppression', count(*)::int from suppression`);
  for (const r of rows as unknown as { t: string; n: number }[]) console.log(`${r.t.padEnd(24)} ${r.n}`);
  process.exit(0);
}
main();
