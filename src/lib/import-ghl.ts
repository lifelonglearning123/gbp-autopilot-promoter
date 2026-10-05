import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, suppression } from "@/db/schema";
import { agencyKey, emailType, tidyEmail } from "./contact-rules";
import { contactsTagged } from "./ghl";

/**
 * The GHL agency list (contacts tagged `ghl-agency`) into our tables: one
 * agency per web domain, one contact per email. Safe to run again: existing
 * rows are matched, not duplicated. GHL do-not-disturb is never contacted.
 */
export const GHL_TAG = "ghl-agency";

export async function importGhl(opts: { write: boolean }) {
  const list = await contactsTagged(GHL_TAG);
  const counts = { inGhl: list.length, usable: 0, noEmail: 0, free: 0, ghlInvalid: 0, dnd: 0, newAgencies: 0, newContacts: 0 };
  const rows = [];
  for (const c of list) {
    const email = tidyEmail(c.email);
    if (!email) {
      counts.noEmail++;
      continue;
    }
    if (c.validEmail === false) counts.ghlInvalid++;
    if (c.dnd) counts.dnd++;
    if (emailType(email) === "free") counts.free++;
    rows.push({ c, email, key: agencyKey(c.website, email) });
  }
  counts.usable = rows.length;
  if (!opts.write) return { ...counts, agencies: new Set(rows.map((r) => r.key)).size };

  for (const { c, email, key } of rows) {
    const inserted = await db()
      .insert(agencies)
      .values({ name: (c.companyName || key).trim(), domain: key, website: c.website ?? null, country: c.country ?? null })
      .onConflictDoNothing({ target: agencies.domain })
      .returning({ id: agencies.id });
    if (inserted.length) counts.newAgencies++;
    const [agency] = await db().select({ id: agencies.id }).from(agencies).where(sql`${agencies.domain} = ${key}`).limit(1);
    const added = await db()
      .insert(contacts)
      .values({
        agencyId: agency.id,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        email,
        emailType: emailType(email),
        emailStatus: c.validEmail === false ? "invalid" : "unverified",
        phone: c.phone ?? null,
        country: c.country ?? null,
        source: `ghl:${c.source ?? GHL_TAG}`,
        ghlContactId: c.id,
      })
      .onConflictDoNothing()
      .returning({ id: contacts.id });
    if (added.length) counts.newContacts++;
    if (c.dnd) await db().insert(suppression).values({ email, reason: "ghl do-not-disturb" }).onConflictDoNothing();
  }
  return { ...counts, agencies: new Set(rows.map((r) => r.key)).size };
}
