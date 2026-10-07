import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, agencyResearch, contacts } from "@/db/schema";
import { env } from "@/env";
import { crawlSite } from "./crawl";
import { askJson } from "./openrouter";

/**
 * Research one agency and keep it for good.
 *
 * Reads its site, asks the analysis model what the agency is and how well it
 * fits GBP Autopilot, and writes a NEW agency_research version every time —
 * never an overwrite — with the raw page text, so it can be re-read or
 * re-scored later. The agency row gets the latest fit score, brand guess and
 * status. Published emails that match a contact are recorded as proof of where
 * the address was found (what CASL asks for).
 */

export const FIT_FLOOR = 40;

export type Facts = {
  trading_name: string | null;
  is_agency: boolean;
  offers_local_seo: boolean;
  offers_gbp_management: boolean;
  services: string[];
  niches: string[];
  resells_white_label: boolean;
  white_label_tools: string[];
  uses_gohighlevel: boolean;
  team_size: "solo" | "2-10" | "11-50" | "50+" | "unknown";
  location: string | null;
  case_study_clients: { name: string; town: string | null }[];
  summary: string;
  fit_score: number;
  fit_reasoning: string;
  best_sample: "own" | "client" | "prospect";
  brand_colour_guess: string | null;
};

const SYSTEM = `You research marketing agencies for GBP Autopilot, a white-label platform agencies resell to local businesses: it scores and improves each client's Google Business Profile, answers reviews, posts weekly and reports, all under the agency's own brand. Price: from £149 a month.

From the agency's own web pages, return ONLY a JSON object with exactly these keys:
trading_name (string|null: the agency's name as its own site writes it, e.g. "Smash Marketing" — not a page title or slogan),
is_agency (bool: a marketing/web/SEO agency or freelancer selling to businesses),
offers_local_seo (bool), offers_gbp_management (bool: Google Business Profile / Google Maps work),
services (string[], short), niches (string[]: industries they serve, e.g. "dentists", "trades"),
resells_white_label (bool), white_label_tools (string[]), uses_gohighlevel (bool: mentions GoHighLevel/HighLevel/a GHL SaaS),
team_size ("solo"|"2-10"|"11-50"|"50+"|"unknown"), location (string|null: town, country),
case_study_clients (array of {name, town|null}: real local businesses named as their clients, max 5),
summary (2 sentences, plain), fit_score (integer 0-100), fit_reasoning (1-2 sentences),
best_sample ("own"|"client"|"prospect": which business a sample audit should be of — their own listing if they are local and have one, a named local client if there is one, else "prospect"),
brand_colour_guess (hex like "#1a73e8" or null).

Fit score rubric: 80-100 sells local SEO/GBP to local businesses and already resells tools; 60-79 local-business marketing, likely to add GBP work; 40-59 general digital agency with some local clients; 0-39 not an agency, enterprise-only, ecommerce-only, or no local work. Judge only from the pages. Never invent clients or facts; use empty arrays, false and null when the pages do not say.`;

export type ResearchOutcome =
  | { ok: true; fitScore: number; status: string; version: number; costUsd: number | null }
  | { ok: false; why: string };

export async function researchAgency(agencyId: string): Promise<ResearchOutcome> {
  const [agency] = await db().select().from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (!agency) return { ok: false, why: "no such agency" };
  const site = agency.website || (agency.domain.startsWith("email:") ? null : agency.domain);
  if (!site) {
    await db().update(agencies).set({ status: "no_website", updatedAt: new Date() }).where(eq(agencies.id, agencyId));
    return { ok: false, why: "no website" };
  }

  const crawl = await crawlSite(site);
  if (!crawl || crawl.pages.every((p) => p.text.length < 200)) {
    await db().update(agencies).set({ status: "unreachable", updatedAt: new Date() }).where(eq(agencies.id, agencyId));
    return { ok: false, why: "site unreachable or empty" };
  }

  const pagesForModel = crawl.pages
    .map((p) => `### ${p.title || p.url}\n${p.url}\n${p.text}`)
    .join("\n\n")
    .slice(0, 28_000);

  const { data: facts, usage } = await askJson<Facts>({
    model: env.ANALYSIS_MODEL,
    system: SYSTEM,
    user: `Agency: ${agency.name}\nWebsite: ${site}\n\n${pagesForModel}`,
    maxTokens: 1500,
  });
  const fit = Math.max(0, Math.min(100, Math.round(Number(facts.fit_score) || 0)));

  const [{ next }] = await db()
    .select({ next: sql<number>`coalesce(max(${agencyResearch.version}), 0) + 1` })
    .from(agencyResearch)
    .where(eq(agencyResearch.agencyId, agencyId));

  await db().insert(agencyResearch).values({
    agencyId,
    version: next,
    pagesCrawled: crawl.pages.map((p) => p.url),
    rawText: crawl.pages.map((p) => `### ${p.url}\n${p.text}`).join("\n\n"),
    signals: { logos: crawl.logos, themeColour: crawl.themeColour, emails: crawl.emails },
    facts: facts as unknown as Record<string, unknown>,
    summary: facts.summary ?? null,
    fitScore: fit,
    fitReasoning: facts.fit_reasoning ?? null,
    model: usage.model,
  });

  const colour = crawl.themeColour ?? (/^#[0-9a-f]{6}$/i.test(facts.brand_colour_guess ?? "") ? facts.brand_colour_guess : null);
  const status = !facts.is_agency || fit < FIT_FLOOR ? "skipped" : "researched";
  // Agencies found by their site (not from a list) start named after their domain; the brand goes on the sample audit.
  const tradingName = (facts.trading_name ?? "").trim();
  const rename = agency.name === agency.domain && tradingName.length >= 2 && tradingName.length <= 60;
  await db()
    .update(agencies)
    .set({
      ...(rename ? { name: tradingName } : {}),
      fitScore: fit,
      branding: { logoUrl: crawl.logos[0] ?? null, colour },
      status,
      updatedAt: new Date(),
    })
    .where(eq(agencies.id, agencyId));

  // Where each contact's address was published, if it was: proof of source.
  const seenAt = new Date().toISOString();
  for (const { email, url } of crawl.emails) {
    await db()
      .update(contacts)
      .set({ sourceProof: { url, seenAt }, updatedAt: new Date() })
      .where(and(eq(contacts.agencyId, agencyId), eq(contacts.email, email)));
  }

  return { ok: true, fitScore: fit, status, version: next, costUsd: usage.costUsd };
}
