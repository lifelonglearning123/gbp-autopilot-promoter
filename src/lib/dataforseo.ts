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

/** One Google search (live, organic), or [] when DataForSEO is not set up or fails. */
async function google(keyword: string, locationCode: number, depth: number): Promise<SerpItem[]> {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) return [];
  const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ keyword, language_code: "en", location_code: locationCode, depth }]),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as { tasks?: { status_code?: number; status_message?: string; result?: { items?: SerpItem[] }[] }[] };
  const task = body.tasks?.[0];
  // Out of credit (402 / 40200) or refused: say so, so it shows in the run's problems.
  if (!res.ok || (task?.status_code ?? 20000) >= 40000) throw new Error(`DataForSEO ${res.status}: ${task?.status_message ?? res.statusText}`);
  return task?.result?.[0]?.items ?? [];
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
