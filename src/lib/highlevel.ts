import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, agencyResearch, contacts, controls } from "@/db/schema";
import { env } from "@/env";
import { domainOf, emailType, looksLikeAgency, pickSiteEmail, tidyEmail } from "./contact-rules";
import { sitesUsing } from "./dataforseo";

/**
 * Agencies that already run HighLevel, found by their own website:
 *   find      once a day, the next sites DataForSEO has seen running HighLevel
 *             in each of HIGHLEVEL_COUNTRIES; the agency-like ones become new
 *             agencies (named after their domain until research reads their
 *             trading name), with any address DataForSEO saw on the site
 *   contacts  a researched agency with no address we can use gets the one its
 *             own site publishes (also mends list agencies whose address bounced)
 * Research, verification, drafting and the 24h hold then run as for the GHL list.
 */

type Log = (line: string) => void;

const HIGHLEVEL = { path: "marketing.crm", name: "HighLevel" };
export const SOURCE = "highlevel:dataforseo";

type State = { day?: string; offsets?: Record<string, number>; totals?: Record<string, number> };

export async function discoverHighLevel(log: Log) {
  const countries = env.HIGHLEVEL_COUNTRIES.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (countries.length === 0 || env.HIGHLEVEL_DAILY <= 0) return;
  const [row] = await db().select().from(controls).where(eq(controls.key, "highlevel")).limit(1);
  const state = (row?.value as State | undefined) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  if (state.day === today) return;
  const offsets = { ...state.offsets };
  const totals = { ...state.totals };

  // The day's sites go to the first country not yet read to the end.
  const country = countries.find((c) => totals[c] === undefined || (offsets[c] ?? 0) < totals[c]);
  const tally = { looked: 0, agencyLike: 0, added: 0, withEmail: 0 };
  if (country) {
    const { total, sites } = await sitesUsing(HIGHLEVEL, country, offsets[country] ?? 0, env.HIGHLEVEL_DAILY);
    totals[country] = total;
    offsets[country] = (offsets[country] ?? 0) + sites.length;
    if (sites.length === 0) offsets[country] = total; // nothing more there
    tally.looked = sites.length;
    for (const s of sites) {
      const domain = domainOf(s.domain);
      if (!domain || !looksLikeAgency(`${s.title} ${s.description}`)) continue;
      tally.agencyLike++;
      const [added] = await db()
        .insert(agencies)
        .values({ name: domain, domain, website: `https://${s.domain.replace(/^www\./, "")}/`, country })
        .onConflictDoNothing({ target: agencies.domain })
        .returning({ id: agencies.id });
      if (!added) continue;
      tally.added++;
      const email = pickSiteEmail(s.emails, domain);
      if (!email) continue;
      const inserted = await db()
        .insert(contacts)
        .values({
          agencyId: added.id,
          email,
          emailType: emailType(email),
          country,
          source: SOURCE,
          // Research replaces this with the exact page if it sees the address there.
          sourceProof: { url: `https://${domain}/`, seenAt: new Date().toISOString() },
        })
        .onConflictDoNothing()
        .returning({ id: contacts.id });
      if (inserted.length) tally.withEmail++;
    }
    log(
      `highlevel find (${country}): ${tally.looked} sites, ${tally.agencyLike} agency-like, ${tally.added} new agencies, ${tally.withEmail} with an address — ${offsets[country]} of ${total} read`,
    );
  }
  const value = { day: today, offsets, totals, last: { country, ...tally } };
  await db()
    .insert(controls)
    .values({ key: "highlevel", value })
    .onConflictDoUpdate({ target: controls.key, set: { value, updatedAt: new Date() } });
}

/** Researched agencies with no address we could write to (none, or all invalid/risky) get one their site publishes. */
export async function contactsFromSites(limit: number, log: Log) {
  const todo = (await db().execute(sql`
    select a.id, a.domain, a.country from agencies a
    where a.status = 'researched'
      and not exists (select 1 from contacts c where c.agency_id = a.id and c.email_status in ('valid', 'unverified', 'pending'))
    order by a.fit_score desc nulls last
    limit ${limit}`)) as unknown as { id: string; domain: string; country: string | null }[];
  let added = 0;
  let none = 0;
  for (const a of todo) {
    const [latest] = await db()
      .select({ signals: agencyResearch.signals })
      .from(agencyResearch)
      .where(eq(agencyResearch.agencyId, a.id))
      .orderBy(desc(agencyResearch.version))
      .limit(1);
    const seen = ((latest?.signals as { emails?: { email: string; url: string }[] } | undefined)?.emails ?? []).filter((e) => tidyEmail(e.email));
    const known = new Set(
      (await db().select({ email: contacts.email }).from(contacts).where(eq(contacts.agencyId, a.id))).map((c) => c.email),
    );
    const email = pickSiteEmail(
      seen.map((e) => e.email).filter((e) => !known.has(tidyEmail(e)!)),
      a.domain,
    );
    if (!email) {
      none++;
      // Nothing to find on the site: set aside so it is not looked at every hour.
      await db().update(agencies).set({ status: "no_email", updatedAt: new Date() }).where(and(eq(agencies.id, a.id), eq(agencies.status, "researched")));
      continue;
    }
    const url = seen.find((e) => tidyEmail(e.email) === email)!.url;
    const inserted = await db()
      .insert(contacts)
      .values({
        agencyId: a.id,
        email,
        emailType: emailType(email),
        country: a.country,
        source: `site:${domainOf(url) ?? a.domain}`,
        sourceProof: { url, seenAt: new Date().toISOString() },
      })
      .onConflictDoNothing()
      .returning({ id: contacts.id });
    if (inserted.length) added++;
  }
  if (todo.length) log(`site contacts: ${added} added, ${none} agencies publish none we can use`);
}
