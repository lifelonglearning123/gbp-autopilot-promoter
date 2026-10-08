import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, agencyResearch, contacts, events, samples } from "@/db/schema";
import { env } from "@/env";
import { get } from "./crawl";
import { ghlTraces, internalLinks, pageText, pageTitle } from "./crawl-rules";
import { searchGoogle } from "./dataforseo";
import { esc } from "./notify";
import { askJson } from "./openrouter";

/**
 * A sales brief on an agency that opened its audit, for the owner's alert
 * (the owner's choice, 2026-10-08): who runs it, what it sells and for how
 * much, how it does Google Business Profile work today, its tools, and hooks
 * for a personal note. Built from public business sources only — the agency's
 * own pages (beyond those research read) and what Google shows for its name —
 * every point with the page it came from. Kept as an event so it is made once.
 */

export type Brief = {
  snapshot: string;
  people: { name: string; role: string; source: string }[];
  sells: { text: string; source: string }[];
  gbp_today: { text: string; source: string }[];
  stack: { text: string; source: string }[];
  for_us: string[];
  against_us: string[];
  hooks: string[];
};

const MORE_PAGES = /about|team|founder|story|who-we-are|our-people|case-stud|results|work|portfolio|pricing|packages|plans|reviews|testimonials/i;

const SYSTEM = `You prepare a short sales brief on a marketing agency for Chao, founder of GBP Autopilot, who will write them a personal note. GBP Autopilot is a white-label platform agencies resell to local businesses: it scores and improves each client's Google Business Profile, answers reviews, posts weekly and reports, under the agency's brand, and works with GoHighLevel.

You get numbered sources ([S1], [S2]...), each with its URL. Use ONLY what they say. Return ONLY a JSON object:
{"snapshot": string (2 sentences: what they are, where, how big, how long trading — only what sources say),
 "people": [{"name", "role", "source"}] (people who run or work at the agency, with their job role only),
 "sells": [{"text", "source"}] (services and prices),
 "gbp_today": [{"text", "source"}] (how they do Google Business Profile / reviews / local SEO work now),
 "stack": [{"text", "source"}] (tools they use, e.g. GoHighLevel, WordPress),
 "for_us": string[] (why GBP Autopilot fits them, max 3, each tied to a fact above),
 "against_us": string[] (why they might not buy, max 2),
 "hooks": string[] (2-3 specific openings for a personal note, each built on a fact above)}
"source" is the URL of the source that says it, exactly as given. Leave out anything no source says; never guess. Business facts only: no home addresses, personal phone numbers, family or private life. Plain, short sentences.`;

export async function agencyBrief(agencyId: string): Promise<Brief | null> {
  const [agency] = await db().select().from(agencies).where(eq(agencies.id, agencyId)).limit(1);
  if (!agency) return null;
  const [research] = await db().select().from(agencyResearch).where(eq(agencyResearch.agencyId, agencyId)).orderBy(desc(agencyResearch.version)).limit(1);
  const [contact] = await db().select().from(contacts).where(eq(contacts.agencyId, agencyId)).limit(1);
  const [sample] = await db().select().from(samples).where(eq(samples.agencyId, agencyId)).orderBy(desc(samples.createdAt)).limit(1);

  const sources: { url: string; text: string }[] = [];
  if (research?.rawText) sources.push({ url: research.pagesCrawled[0] ?? agency.website ?? agency.domain, text: research.rawText.slice(0, 9000) });

  // Their pages research did not read: about, team, case studies, pricing, reviews.
  const site = agency.website ?? (agency.domain.startsWith("email:") ? null : `https://${agency.domain}/`);
  const ghl = new Set<string>(((research?.signals as { ghl?: { trace: string }[] } | undefined)?.ghl ?? []).map((g) => g.trace));
  if (site) {
    const home = await get(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    if (home) {
      ghlTraces(home.html).forEach((t) => ghl.add(t));
      const seen = new Set(research?.pagesCrawled ?? []);
      const more = internalLinks(home.html, home.url)
        .filter((u) => MORE_PAGES.test(new URL(u).pathname) && !seen.has(u))
        .slice(0, 4);
      for (const url of more) {
        const page = await get(url);
        if (!page) continue;
        ghlTraces(page.html).forEach((t) => ghl.add(t));
        sources.push({ url: page.url, text: `${pageTitle(page.html)}\n${pageText(page.html, 4000)}` });
      }
      if (ghl.size) sources.push({ url: home.url, text: `In the page code (not visible text): ${[...ghl].join("; ")}. These are GoHighLevel's.` });
    }
  }

  // What Google shows for the agency and the people behind it.
  for (const q of [`"${agency.name}"`, `"${agency.name}" founder OR owner OR CEO OR linkedin`]) {
    const results = await searchGoogle(q, agency.country, 10).catch(() => []);
    for (const r of results.slice(0, 8)) sources.push({ url: r.url, text: `${r.title}\n${r.snippet}` });
  }
  if (sources.length === 0) return null;

  const user = [
    `Agency: ${agency.name} (${site ?? agency.domain})`,
    `The person we wrote to: ${[contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || "(no name)"} <${contact?.email ?? ""}>`,
    sample ? `Our sample audit of ${sample.kind === "own" ? "their own" : "a client's"} Google Business Profile scored ${sample.score}/100.` : "",
    "",
    ...sources.map((s, i) => `[S${i + 1}] ${s.url}\n${s.text}`),
  ]
    .join("\n")
    .slice(0, 40_000);
  const { data } = await askJson<Brief>({ model: env.ANALYSIS_MODEL, system: SYSTEM, user, maxTokens: 2000 });
  // A point whose source is not one we gave is dropped: nothing reaches the owner unsourced.
  const allowed = new Set(sources.map((s) => s.url));
  const sourced = <T extends { source: string }>(xs: T[] | undefined) => (Array.isArray(xs) ? xs : []).filter((x) => allowed.has(x.source));
  const strings = (xs: unknown, n: number) => (Array.isArray(xs) ? xs.map(String) : []).slice(0, n);
  return {
    snapshot: String(data.snapshot ?? ""),
    people: sourced(data.people),
    sells: sourced(data.sells),
    gbp_today: sourced(data.gbp_today),
    stack: sourced(data.stack),
    for_us: strings(data.for_us, 3),
    against_us: strings(data.against_us, 2),
    hooks: strings(data.hooks, 3),
  };
}

/** The brief as HTML for the owner's email: made once per agency a week, then reused. */
export async function briefHtml(agencyId: string): Promise<string> {
  const [kept] = await db()
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.agencyId, agencyId), eq(events.type, "lead.brief"), gt(events.at, new Date(Date.now() - 7 * 86_400_000))))
    .orderBy(desc(events.at))
    .limit(1);
  let brief = kept?.payload as unknown as Brief | undefined;
  if (!brief) {
    const made = await agencyBrief(agencyId);
    if (!made) return "";
    brief = made;
    await db().insert(events).values({ source: "bot", type: "lead.brief", agencyId, payload: made as unknown as Record<string, unknown> });
  }
  return renderBrief(brief);
}

export function renderBrief(b: Brief): string {
  const link = (url: string) => `<a href="${esc(url)}" style="color:#666">source</a>`;
  const list = (title: string, xs: { text: string; source: string }[]) =>
    xs.length ? `<p style="margin:12px 0 4px"><b>${title}</b></p><ul style="margin:0">${xs.map((x) => `<li>${esc(x.text)} (${link(x.source)})</li>`).join("")}</ul>` : "";
  const plain = (title: string, xs: string[]) =>
    xs.length ? `<p style="margin:12px 0 4px"><b>${title}</b></p><ul style="margin:0">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  return `<div style="border-top:1px solid #ddd;margin-top:20px;padding-top:12px">
    <p style="margin:0 0 6px"><b>Brief</b> (public sources; check before you quote)</p>
    <p style="margin:0">${esc(b.snapshot)}</p>
    ${list("People", b.people.map((p) => ({ text: `${p.name} — ${p.role}`, source: p.source })))}
    ${list("What they sell", b.sells)}
    ${list("Google Business Profile work today", b.gbp_today)}
    ${list("Tools", b.stack)}
    ${plain("Why we fit", b.for_us)}
    ${plain("Why they might not buy", b.against_us)}
    ${plain("Hooks for a note", b.hooks)}
  </div>`;
}
