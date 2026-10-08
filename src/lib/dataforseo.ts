import { env } from "@/env";
import { hostOf } from "./creator-rules";

/**
 * DataForSEO's Google search (SERP API, live): TikTok creators found through
 * Google, and for creators who publish no links, their name searched on
 * Google, the first result that is a business's own site — and whose name
 * matches theirs — taken as their website.
 */

const LOCATION: Record<string, number> = { US: 2840, GB: 2826, UK: 2826, CA: 2124, AU: 2036, NZ: 2554, IE: 2372 };

/** Results that are never a creator's own site. */
const NOT_A_SITE =
  /(^|\.)(youtube\.com|youtu\.be|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|tiktok\.com|pinterest\.com|reddit\.com|quora\.com|medium\.com|yelp\.[a-z.]+|clutch\.co|upwork\.com|fiverr\.com|freelancer\.com|bark\.com|trustpilot\.com|g2\.com|crunchbase\.com|zoominfo\.com|apollo\.io|rocketreach\.co|wikipedia\.org|google\.[a-z.]+|bing\.com|amazon\.[a-z.]+|podcasts\.apple\.com|spotify\.com|skool\.com|linktr\.ee|bbb\.org|yellowpages\.[a-z.]+|indeed\.com|glassdoor\.[a-z.]+)$/;

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !["the", "and", "seo", "local", "digital", "marketing", "agency", "media", "with", "for", "google", "tips", "llc", "inc", "ltd"].includes(w));

/** Does this result look like the channel's own business? Its domain or title carries the channel's distinctive words. */
export function looksLikeTheirs(channelTitle: string, url: string, resultTitle: string): boolean {
  const host = hostOf(url);
  if (!host || NOT_A_SITE.test(host)) return false;
  const name = words(channelTitle.split(/[|\-–—]/)[0]);
  if (name.length === 0) return false;
  const domain = host.replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/g, "");
  const title = words(resultTitle);
  return name.some((w) => domain.includes(w)) || name.filter((w) => title.includes(w)).length >= Math.min(2, name.length);
}

type SerpItem = { type?: string; url?: string; title?: string; description?: string };

/**
 * One Google search (live, organic), or [] when DataForSEO is not set up.
 * Google's side often fails once and answers the next time (40101 "Internal
 * SE Server Error", 40102 "No Search Results" for a query that has results),
 * so those get one more try; a second 40102 is an empty answer.
 */
async function google(keyword: string, locationCode: number, depth: number): Promise<SerpItem[]> {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) return [];
  const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ keyword, language_code: "en", location_code: locationCode, depth }]),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { tasks?: { status_code?: number; status_message?: string; result?: { items?: SerpItem[] }[] }[] };
    const task = body.tasks?.[0];
    const code = task?.status_code ?? (res.ok ? 20000 : res.status);
    if ((code === 40101 || code === 40102) && attempt === 0) continue;
    if (code === 40102) return [];
    // Out of credit (402 / 40200) or refused: say so, so it shows in the run's problems.
    if (!res.ok || code >= 40000) throw new Error(`DataForSEO ${res.status}: ${task?.status_message ?? res.statusText}`);
    return task?.result?.[0]?.items ?? [];
  }
}

/**
 * TikTok profiles and videos Google has for a phrase (TikTok has no public
 * search API): each result's URL, title and snippet. US and UK in turn.
 */
export async function searchTikTok(phrase: string, country: "US" | "GB"): Promise<{ url: string; title: string; snippet: string }[]> {
  const items = await google(`site:tiktok.com ${phrase}`, LOCATION[country], 50);
  return items
    .filter((i) => i.url && /tiktok\.com\/@/.test(i.url))
    .map((i) => ({ url: i.url!, title: i.title ?? "", snippet: i.description ?? "" }));
}

export async function findWebsite(channelTitle: string, country: string | null): Promise<string | null> {
  const name = channelTitle.split(/[|\-–—]/)[0].trim();
  const items = await google(name, LOCATION[(country ?? "").toUpperCase()] ?? 2840, 10);
  const hit = items.find((i) => i.type === "organic" && i.url && looksLikeTheirs(channelTitle, i.url, i.title ?? ""));
  if (!hit?.url) return null;
  const u = new URL(hit.url);
  return `${u.protocol}//${u.host}/`;
}

/** Google's organic results for a phrase in a country: what anyone searching would see. */
export async function searchGoogle(keyword: string, country: string | null, depth = 10): Promise<{ url: string; title: string; snippet: string }[]> {
  const items = await google(keyword, LOCATION[(country ?? "").toUpperCase()] ?? 2840, depth);
  return items
    .filter((i) => i.type === "organic" && i.url)
    .map((i) => ({ url: i.url!, title: i.title ?? "", snippet: i.description ?? "" }));
}

export type TechSite = { domain: string; title: string; description: string; emails: string[] };

/**
 * Sites DataForSEO has seen running a technology (its Wappalyzer-style
 * lookup), in one country, biggest first. HighLevel is "marketing.crm".
 */
export async function sitesUsing(
  tech: { path: string; name: string },
  country: string,
  offset: number,
  limit: number,
): Promise<{ total: number; sites: TechSite[] }> {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) return { total: 0, sites: [] };
  const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
  const res = await fetch("https://api.dataforseo.com/v3/domain_analytics/technologies/domains_by_technology/live", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      { technology_paths: [tech], filters: [["country_iso_code", "=", country]], order_by: ["domain_rank,desc"], offset, limit },
    ]),
    signal: AbortSignal.timeout(120_000),
  });
  type Item = { domain?: string; title?: string; description?: string; meta_keywords?: string[]; emails?: string[] };
  const body = (await res.json().catch(() => ({}))) as { tasks?: { status_code?: number; status_message?: string; result?: { total_count?: number; items?: Item[] }[] }[] };
  const task = body.tasks?.[0];
  if (!res.ok || (task?.status_code ?? 0) >= 40000) throw new Error(`DataForSEO ${res.status}: ${task?.status_message ?? res.statusText}`);
  const r = task?.result?.[0];
  return {
    total: r?.total_count ?? 0,
    sites: (r?.items ?? [])
      .filter((i) => i.domain)
      .map((i) => ({
        domain: i.domain!,
        title: i.title ?? "",
        description: [i.description ?? "", ...(i.meta_keywords ?? [])].join(" "),
        emails: (i.emails ?? []).map((e) => e.split("?")[0]),
      })),
  };
}
