/**
 * Set each agency's country from where its own site says it is (the GHL list
 * called everyone GB), then send US agencies whose first email was written
 * with the UK price — and is not yet in Instantly — back to be written again
 * at $199. Emails already in Instantly or sent stay as they are. Creators are
 * left alone.
 *   npm run fix:countries            (what would change)
 *   npm run fix:countries -- --write (change it)
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { countryFromLocation } from "../src/lib/crawl-rules";

async function main() {
  const write = process.argv.includes("--write");
  const rows = (await db().execute(sql`
    select distinct on (a.id) a.id, a.country, r.facts->>'location' loc
    from agencies a join agency_research r on r.agency_id = a.id
    where a.status <> 'partner'
    order by a.id, r.version desc`)) as unknown as { id: string; country: string | null; loc: string | null }[];

  const moves: Record<string, number> = {};
  const changes: { id: string; to: string }[] = [];
  for (const r of rows) {
    const to = countryFromLocation(r.loc);
    if (!to || to === r.country) continue;
    changes.push({ id: r.id, to });
    moves[`${r.country ?? "?"} → ${to}`] = (moves[`${r.country ?? "?"} → ${to}`] ?? 0) + 1;
  }
  console.log(`${rows.length} researched agencies; ${changes.length} change country:`, moves);

  // US agencies with an unpushed, unsent first email: written at £149, to write again.
  const toUs = new Set(changes.filter((c) => c.to === "US").map((c) => c.id));
  const unpushed = (await db().execute(sql`
    select distinct a.id, a.name, a.status, a.country from agencies a
    join contacts c on c.agency_id = a.id
    join messages m on m.contact_id = c.id and m.step = 1 and m.pushed_at is null and m.sent_at is null and m.stopped_at is null
    where a.status in ('queued', 'needs_review')
      and c.source not like 'partner:%' and c.source not like 'youtube:%'`)) as unknown as { id: string; name: string; status: string; country: string | null }[];
  const redo = unpushed.filter((a) => toUs.has(a.id) || a.country === "US");
  console.log(`${redo.length} US agencies have a first email not yet in Instantly; written again at $199:`, redo.map((r) => r.name).join(", "));

  if (!write) {
    console.log("\nNothing changed. Run with --write to apply.");
    process.exit(0);
  }
  for (const c of changes) await db().execute(sql`update agencies set country = ${c.to}, updated_at = now() where id = ${c.id}`);
  for (const r of redo) {
    await db().execute(sql`
      delete from messages m using contacts c
      where c.id = m.contact_id and c.agency_id = ${r.id} and m.step between 1 and 4
        and m.pushed_at is null and m.sent_at is null`);
    await db().execute(sql`update agencies set status = 'researched', updated_at = now() where id = ${r.id} and status in ('queued', 'needs_review')`);
  }
  console.log(`Done: ${changes.length} countries set, ${redo.length} agencies back to "researched" for drafting at $199.`);
  process.exit(0);
}
main();
