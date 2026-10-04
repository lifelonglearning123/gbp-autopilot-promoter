/**
 * Import the GHL agency list (contacts tagged `ghl-agency`) into the bot's database.
 *
 *   npm run import:ghl              → imports (needs DATABASE_URL)
 *   npm run import:ghl -- --dry-run → reads GHL and reports, writes nothing
 *
 * One agency per web domain; one contact per email. Safe to run again: existing
 * rows are matched, not duplicated. Prints counts only — never names, emails or keys.
 */
import { sql } from "drizzle-orm";
import { env } from "../src/env";
import { contactsTagged, type GhlContact } from "../src/lib/ghl";
import { agencyKey, emailType, tidyEmail } from "../src/lib/contact-rules";

const TAG = "ghl-agency";
const dryRun = process.argv.includes("--dry-run") || !env.DATABASE_URL;

type Row = { contact: GhlContact; email: string; key: string };

async function main() {
  const list = await contactsTagged(TAG);
  const rows: Row[] = [];
  let noEmail = 0;
  let flaggedInvalid = 0;
  let dnd = 0;
  for (const c of list) {
    const email = tidyEmail(c.email);
    if (!email) {
      noEmail++;
      continue;
    }
    if (c.validEmail === false) flaggedInvalid++;
    if (c.dnd) dnd++;
    rows.push({ contact: c, email, key: agencyKey(c.website, email) });
  }
  const free = rows.filter((r) => emailType(r.email) === "free").length;
  const agencies = new Set(rows.map((r) => r.key)).size;

  console.log(`GHL contacts tagged ${TAG}: ${list.length}`);
  console.log(`  usable emails ${rows.length} (no email ${noEmail})`);
  console.log(`  work ${rows.length - free}, free-mail ${free}`);
  console.log(`  GHL says invalid ${flaggedInvalid}, do-not-disturb ${dnd}`);
  console.log(`  distinct agencies ${agencies}`);

  if (dryRun) {
    console.log(env.DATABASE_URL ? "\nDry run: nothing written." : "\nNo DATABASE_URL yet: dry run, nothing written.");
    return;
  }

  const { db } = await import("../src/db/client");
  const { agencies: agenciesT, contacts, suppression } = await import("../src/db/schema");

  let newAgencies = 0;
  let newContacts = 0;
  for (const r of rows) {
    const c = r.contact;
    const name = (c.companyName || r.key).trim();
    const inserted = await db()
      .insert(agenciesT)
      .values({ name, domain: r.key, website: c.website ?? null, country: c.country ?? null })
      .onConflictDoNothing({ target: agenciesT.domain })
      .returning({ id: agenciesT.id });
    if (inserted.length) newAgencies++;
    const [agency] = await db()
      .select({ id: agenciesT.id })
      .from(agenciesT)
      .where(sql`${agenciesT.domain} = ${r.key}`)
      .limit(1);

    const added = await db()
      .insert(contacts)
      .values({
        agencyId: agency.id,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        email: r.email,
        emailType: emailType(r.email),
        emailStatus: c.validEmail === false ? "invalid" : "unverified",
        phone: c.phone ?? null,
        country: c.country ?? null,
        source: `ghl:${c.source ?? TAG}`,
        ghlContactId: c.id,
      })
      .onConflictDoNothing()
      .returning({ id: contacts.id });
    if (added.length) newContacts++;

    // Asked GHL not to be disturbed: never contacted, whatever else happens.
    if (c.dnd) {
      await db().insert(suppression).values({ email: r.email, reason: "ghl do-not-disturb" }).onConflictDoNothing();
    }
  }
  console.log(`\nWritten: ${newAgencies} new agencies, ${newContacts} new contacts.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
