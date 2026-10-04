/** Fit score spread and a sample of reasons (agency names only). Run: npx dotenv -e .env.local -- tsx scripts/fit-sample.ts */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";

async function main() {
  const bands = await db().execute(sql`
    select case when fit_score >= 60 then '60+' when fit_score >= 40 then '40-59' when fit_score >= 20 then '20-39' else '0-19' end band,
           count(*)::int n
    from agencies where fit_score is not null group by 1 order by 1 desc`);
  for (const b of bands as unknown as { band: string; n: number }[]) console.log(`fit ${b.band.padEnd(6)} ${b.n}`);

  const facts = await db().execute(sql`
    select count(*) filter (where (r.facts->>'is_agency')::boolean) agency,
           count(*) filter (where (r.facts->>'offers_local_seo')::boolean) local_seo,
           count(*) filter (where (r.facts->>'uses_gohighlevel')::boolean) ghl,
           count(*) filter (where (r.facts->>'resells_white_label')::boolean) white_label,
           count(*) total
    from agency_research r`);
  console.log("research facts:", JSON.stringify(facts[0]));

  const sample = await db().execute(sql`
    select a.name, r.fit_score, r.fit_reasoning, r.facts->>'location' loc
    from agency_research r join agencies a on a.id = r.agency_id
    where r.fit_score between 20 and 39 order by random() limit 8`);
  console.log("\nSample of 20-39:");
  for (const s of sample as unknown as { name: string; fit_score: number; fit_reasoning: string; loc: string }[]) {
    console.log(`- ${s.fit_score} ${s.name} (${s.loc ?? "?"}): ${s.fit_reasoning}`);
  }
  process.exit(0);
}
main();
