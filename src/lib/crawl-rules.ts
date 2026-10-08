/**
 * Reading an agency's website: the pure half, pinned by scripts/verify.ts.
 * Regex over HTML on purpose — we want words, links and a few meta tags, not
 * a DOM, and a page that defeats this simply yields less to research.
 */

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** The words a visitor reads, without scripts, styles, nav chrome or markup. */
export function pageText(html: string, max = 8000): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, max);
}

export function pageTitle(html: string): string {
  return decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 200);
}

/** Links on the same site, absolute, without fragments or files. */
export function internalLinks(html: string, base: string): string[] {
  const root = new URL(base);
  const host = root.hostname.replace(/^www\./, "");
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)/gi)) {
    try {
      const u = new URL(m[1], root);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (u.hostname.replace(/^www\./, "") !== host) continue;
      if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|docx?)$/i.test(u.pathname)) continue;
      u.hash = "";
      u.search = "";
      out.add(u.toString().replace(/\/$/, ""));
    } catch {
      // not a link
    }
  }
  out.delete(root.toString().replace(/\/$/, ""));
  return [...out];
}

/** The pages most worth reading for "is this agency a fit?", best first. */
export function pickPages(links: string[], max = 5): string[] {
  const weight = (url: string) => {
    const p = new URL(url).pathname.toLowerCase();
    let w = 0;
    if (/service|what-we-do|solutions|offer/.test(p)) w += 5;
    if (/local|seo|google|gbp|maps|search/.test(p)) w += 5;
    if (/white-?label|partner|reseller|wholesale/.test(p)) w += 4;
    if (/case|work|portfolio|client|result|success/.test(p)) w += 4;
    if (/about|team|who-we-are|story/.test(p)) w += 3;
    if (/pricing|price|packages|plans/.test(p)) w += 3;
    if (/contact/.test(p)) w += 2;
    if (/blog|news|article|post|tag|category|author|privacy|terms|cookie|login|cart/.test(p)) w -= 6;
    w -= p.split("/").filter(Boolean).length; // shallow pages first
    return w;
  };
  return [...links]
    .map((u) => ({ u, w: weight(u) }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .slice(0, max)
    .map((x) => x.u);
}

/** Logo candidates, most likely first: header/logo images, then icons, then the share image. */
export function logoCandidates(html: string, base: string): string[] {
  const abs = (src: string) => {
    try {
      return new URL(decode(src), base).toString();
    } catch {
      return null;
    }
  };
  const found: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/logo/i.test(tag)) continue;
    const src = tag.match(/\b(?:data-src|src)\s*=\s*["']([^"']+)/i)?.[1];
    const url = src && !src.startsWith("data:") ? abs(src) : null;
    if (url) found.push(url);
  }
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["'][^"']*(apple-touch-icon|icon)[^"']*["'][^>]*>/gi)) {
    const href = m[0].match(/href\s*=\s*["']([^"']+)/i)?.[1];
    const url = href ? abs(href) : null;
    if (url) found.push(url);
  }
  const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)/i)?.[1];
  if (og) {
    const url = abs(og);
    if (url) found.push(url);
  }
  return [...new Set(found)].filter((u) => u.startsWith("https://")).slice(0, 6);
}

/** <meta name="theme-color">, as #rrggbb, if the site sets one. */
export function themeColour(html: string): string | null {
  const v = html.match(/<meta\b[^>]*name\s*=\s*["']theme-color["'][^>]*content\s*=\s*["']([^"']+)/i)?.[1]?.trim();
  if (!v) return null;
  const hex = v.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map((c) => c + c).join("").toLowerCase()}`;
  return null;
}

/** Email addresses published on the page (mailto links and plain text). */
export function publishedEmails(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const e = m[0].toLowerCase();
    if (!/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !e.includes("sentry") && !e.includes("example.")) out.add(e);
  }
  return [...out].slice(0, 20);
}

/**
 * What in a page's code shows it runs on GoHighLevel: its chat widget, form
 * and booking embeds (LeadConnector), its link and file domains, or a branded
 * booking page (/widget/booking/). Page text alone misses these.
 */
const GHL_TRACES: [RegExp, string][] = [
  [/leadconnectorhq\.com/i, "LeadConnector widget or form"],
  [/msgsndr\.com/i, "GoHighLevel link domain (msgsndr)"],
  [/filesafe\.space/i, "GoHighLevel file storage"],
  [/\/widget\/(booking|form|survey)\//i, "GoHighLevel booking or form page"],
  [/gohighlevel\.com|\bhighlevel\b/i, "mentions HighLevel"],
];

export function ghlTraces(html: string): string[] {
  return GHL_TRACES.filter(([re]) => re.test(html)).map(([, what]) => what);
}

/** ISO country code from where research says an agency is: "Ocala, FL, USA" → "US". Null when it does not say. */
const US_STATES =
  /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
const COUNTRIES: [RegExp, string][] = [
  [/\b(usa|u\.s\.a?\.?|united states)\b/i, "US"],
  [/\b(uk|u\.k\.|united kingdom|great britain|england|scotland|wales|northern ireland)\b/i, "GB"],
  [/\b(ireland|éire)\b/i, "IE"],
  [/\bcanada\b/i, "CA"],
  [/\baustralia\b/i, "AU"],
  [/\bnew zealand\b/i, "NZ"],
  [/\bindia\b/i, "IN"],
];
const US_STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;

export function countryFromLocation(location: string | null | undefined): string | null {
  const loc = (location ?? "").trim();
  if (!loc) return null;
  for (const [re, code] of COUNTRIES) if (re.test(loc)) return code;
  if (US_STATES.test(loc) || US_STATE_NAMES.test(loc)) return "US";
  return null;
}
