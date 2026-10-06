import { env } from "@/env";

/**
 * YouTube Data API v3 (official; an API key from Google Cloud). Free quota is
 * 10,000 units a day: a search costs 100, a channel or playlist read costs 1.
 * Only what YouTube makes public through the API is read — never the
 * captcha-gated "business email".
 */

const BASE = "https://www.googleapis.com/youtube/v3";

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY is not set.");
  const q = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY });
  const res = await fetch(`${BASE}/${path}?${q}`, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`YouTube ${path} ${res.status}: ${body.error?.message ?? ""}`);
  return body;
}

export type FoundVideo = { videoId: string; channelId: string; title: string; publishedAt: string };

/** Recent English videos for a phrase (100 units per call). */
export async function searchVideos(phrase: string, publishedAfter: Date, pageToken?: string) {
  const r = await get<{
    items?: { id: { videoId?: string }; snippet: { channelId: string; title: string; publishedAt: string } }[];
    nextPageToken?: string;
  }>("search", {
    part: "snippet",
    q: phrase,
    type: "video",
    order: "date",
    relevanceLanguage: "en",
    maxResults: "50",
    publishedAfter: publishedAfter.toISOString(),
    ...(pageToken ? { pageToken } : {}),
  });
  const videos: FoundVideo[] = (r.items ?? [])
    .filter((i) => i.id.videoId)
    .map((i) => ({ videoId: i.id.videoId!, channelId: i.snippet.channelId, title: i.snippet.title, publishedAt: i.snippet.publishedAt }));
  return { videos, next: r.nextPageToken };
}

export type Channel = {
  channelId: string;
  title: string;
  handle: string | null;
  description: string;
  country: string | null;
  subscribers: number | null;
  videoCount: number | null;
  uploads: string | null;
  /** The channel's profile picture: the logo for a creator's white-label brand. */
  avatar: string | null;
};

/** Up to 50 channels at once (1 unit). */
export async function channels(ids: string[]): Promise<Channel[]> {
  if (ids.length === 0) return [];
  const r = await get<{
    items?: {
      id: string;
      snippet: { title: string; description?: string; customUrl?: string; country?: string; thumbnails?: Record<string, { url: string }> };
      statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }[];
  }>("channels", { part: "snippet,statistics,contentDetails", id: ids.slice(0, 50).join(","), maxResults: "50" });
  return (r.items ?? []).map((c) => ({
    channelId: c.id,
    title: c.snippet.title,
    handle: c.snippet.customUrl ?? null,
    description: c.snippet.description ?? "",
    country: c.snippet.country ?? null,
    subscribers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? NaN) || null,
    videoCount: Number(c.statistics?.videoCount ?? NaN) || null,
    uploads: c.contentDetails?.relatedPlaylists?.uploads ?? null,
    avatar: c.snippet.thumbnails?.high?.url ?? c.snippet.thumbnails?.medium?.url ?? c.snippet.thumbnails?.default?.url ?? null,
  }));
}

/**
 * Full descriptions of videos (1 unit per 50). Creators put their website,
 * socials, booking link and email under their videos; the channel's own
 * "links" section is not in the API.
 */
export async function videoDescriptions(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await get<{ items?: { snippet: { description?: string } }[] }>("videos", { part: "snippet", id: ids.slice(0, 50).join(",") });
  return (r.items ?? []).map((v) => v.snippet.description ?? "");
}

/** The channel's latest uploads (1 unit). */
export async function recentUploads(playlistId: string, n = 6) {
  const r = await get<{ items?: { snippet: { title: string; publishedAt: string; resourceId: { videoId: string } } }[] }>("playlistItems", {
    part: "snippet",
    playlistId,
    maxResults: String(n),
  });
  return (r.items ?? []).map((i) => ({ id: i.snippet.resourceId.videoId, title: i.snippet.title, publishedAt: i.snippet.publishedAt }));
}
