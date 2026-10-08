/**
 * Give every creator email not yet sent a fresh claim link that carries the
 * creator offer. Until the platform read `offer` (2026-10-08), every creator
 * link — the long signed ones and the short /c/ ones from a sample — opened a
 * normal agency signup. Each creator gets a new short link from the platform,
 * swapped into their unsent emails; leads already in Instantly are re-synced
 * by the hourly run. Run only once the platform with the creator offer is live.
 *   npm run relink:creators            (what would change)
 *   npm run relink:creators -- --write (change it)
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { env } from "../src/env";
import { claimLink } from "../src/lib/platform";

const base = env.PLATFORM_URL.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A claim link of either form; preview links (/preview/…) are left alone.
const CLAIM = new RegExp(`${base}/(?:signup\\?claim=[^\\s)>"]+|c/[A-Za-z0-9_-]+)`, "g");

async function main() {
  const write = process.argv.includes("--write");
  const rows = (await db().execute(sql`
    select c.id, c.email, a.name, a.branding, count(m.id)::int unsent,
           bool_or(m.instantly_lead_id is not null) in_instantly
    from contacts c join agencies a on a.id = c.agency_id
    join messages m on m.contact_id = c.id and m.sent_at is null and m.stopped_at is null
    where c.source like 'partner:%'
    group by c.id, c.email, a.name, a.branding`)) as unknown as {
    id: string;
    email: string;
    name: string;
    branding: { logoUrl: string | null; colour: string | null } | null;
    unsent: number;
    in_instantly: boolean;
  }[];
  console.log(`${rows.length} creators with unsent emails (${rows.filter((r) => r.in_instantly).length} already in Instantly).`);
  if (!write) {
    console.log("Nothing changed. Run with --write once the platform with the creator offer is live.");
    process.exit(0);
  }
  let done = 0;
  for (const r of rows) {
    const link = await claimLink({ agencyName: r.name, email: r.email, logoUrl: r.branding?.logoUrl, colour: r.branding?.colour, externalRef: r.id, offer: "creator" });
    if (!link.shortUrl) throw new Error("The platform gave no short link: is the creator-offer version live?");
    await db().execute(sql`
      update messages set body = regexp_replace(body, ${CLAIM.source}, ${link.shortUrl}, 'g')
      where contact_id = ${r.id} and sent_at is null and stopped_at is null`);
    // Leads already in Instantly carry their emails as variables: mark them for the next sync.
    if (r.in_instantly) await db().execute(sql`delete from events where contact_id = ${r.id} and type = 'lead.vars_synced'`);
    done++;
  }
  console.log(`${done} creators relinked; Instantly copies update on the next hourly run.`);
  process.exit(0);
}
main();
