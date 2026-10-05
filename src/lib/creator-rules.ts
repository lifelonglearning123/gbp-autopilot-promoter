/**
 * Pure rules for YouTube creators' public contact details, pinned by
 * scripts/verify.ts: links sorted by network, emails and phone numbers read
 * from text, and the link a person taps to message them.
 */

export type LinkKind = "instagram" | "skool" | "linktree" | "x" | "linkedin" | "facebook" | "tiktok" | "youtube" | "calendar" | "website";

const NETWORKS: [LinkKind, RegExp][] = [
  ["instagram", /(^|\.)instagram\.com$/],
  ["skool", /(^|\.)skool\.com$/],
  ["linktree", /(^|\.)(linktr\.ee|beacons\.ai|stan\.store|bio\.link|linkin\.bio)$/],
  ["x", /(^|\.)(twitter\.com|x\.com)$/],
  ["linkedin", /(^|\.)linkedin\.com$/],
  ["facebook", /(^|\.)(facebook\.com|fb\.com)$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
  ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/],
  ["calendar", /(^|\.)(calendly\.com|cal\.com|tidycal\.com)$/],
];

/** Hosts that are never the creator's own website (affiliate links, tools, shops). */
const NOT_THEIR_SITE =
  /(^|\.)(amzn\.to|amazon\.[a-z.]+|bit\.ly|gohighlevel\.com|highlevel\.com|leadconnectorhq\.com|google\.com|goo\.gl|g\.page|apple\.com|spotify\.com|patreon\.com|paypal\.me|gumroad\.com|shopify\.com|canva\.com|semrush\.com|ahrefs\.com|brightlocal\.com|whitespark\.ca|hubspot\.com|wordpress\.org|wix\.com|discord\.gg|t\.me|wa\.me|whatsapp\.com)$/;

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Every http(s) link in a text, sorted by network; the first plain site counts as theirs. */
export function sortLinks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const urls = (text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
  for (const url of urls) {
    const host = hostOf(url);
    if (!host) continue;
    const kind = NETWORKS.find(([, re]) => re.test(host))?.[0] ?? (NOT_THEIR_SITE.test(host) ? null : "website");
    if (kind && !out[kind]) out[kind] = url;
  }
  return out;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NOT_AN_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|@(example|domain|email|sentry|wixpress)\./i;

/** Emails written in a text (descriptions often say "business: name@site.com"). */
export function emailsIn(text: string): string[] {
  const found = (text.match(EMAIL) ?? []).map((e) => e.toLowerCase()).filter((e) => !NOT_AN_EMAIL.test(e));
  return [...new Set(found)];
}

/**
 * Phone numbers written in a text: a "+" international number, or a UK/US
 * style number of 10-11 digits next to a phone word or tel: link. Loose
 * digit runs (prices, dates, IDs) are not taken.
 */
export function phonesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/tel:([+\d\s().-]{9,20})/gi)) out.add(tidyPhone(m[1]));
  for (const m of text.matchAll(/(\+\d[\d\s().-]{8,18}\d)/g)) out.add(tidyPhone(m[1]));
  for (const m of text.matchAll(/(?:phone|call|tel|mobile|whatsapp|text)[^\d+(]{0,12}(\(?\d[\d\s().-]{8,15}\d)/gi)) out.add(tidyPhone(m[1]));
  return [...out].filter((p) => {
    const digits = p.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  });
}

function tidyPhone(p: string): string {
  return p.trim().replace(/\s+/g, " ").replace(/[^\d+()\s.-]/g, "");
}

/** "https://www.instagram.com/jo.local/?hl=en" → "jo.local". */
export function instagramHandle(url: string): string | null {
  const m = url.match(/instagram\.com\/([A-Za-z0-9._]{1,30})\/?/);
  return m && !["p", "reel", "reels", "stories", "explore", "accounts"].includes(m[1]) ? m[1] : null;
}

/** The link a person taps to message them on that network. */
export function messageLink(kind: "instagram" | "skool" | "youtube" | "phone", target: string): string {
  if (kind === "instagram") {
    const h = instagramHandle(target);
    return h ? `https://ig.me/m/${h}` : target;
  }
  if (kind === "phone") return `tel:${target.replace(/[^\d+]/g, "")}`;
  return target;
}
