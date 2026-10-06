import { env } from "@/env";
import { hostOf } from "./creator-rules";

/**
 * DataForSEO's Google search (SERP API, live), for creators who publish no
 * links on YouTube: their name searched on Google, the first result that is a
 * business's own site — and whose name matches theirs — taken as their website.
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

export async function findWebsite(channelTitle: string, country: string | null): Promise<string | null> {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) return null;
  const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
  const name = channelTitle.split(/[|\-–—]/)[0].trim();
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ keyword: name, language_code: "en", location_code: LOCATION[(country ?? "").toUpperCase()] ?? 2840, depth: 10 }]),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as {
    tasks?: { result?: { items?: { type?: string; url?: string; title?: string }[] }[] }[];
  };
  const items = body.tasks?.[0]?.result?.[0]?.items ?? [];
  const hit = items.find((i) => i.type === "organic" && i.url && looksLikeTheirs(channelTitle, i.url, i.title ?? ""));
  if (!hit?.url) return null;
  const u = new URL(hit.url);
  return `${u.protocol}//${u.host}/`;
}
