import { internalLinks, logoCandidates, pageText, pageTitle, pickPages, publishedEmails, themeColour } from "./crawl-rules";

/**
 * Read an agency's site: the homepage and up to five pages that say what it
 * does, for whom, and whether it already resells tools. Polite: one page at a
 * time, a browser-like agent, a size cap, and a short timeout per page.
 */

export type CrawledPage = { url: string; title: string; text: string };
export type Crawl = {
  pages: CrawledPage[];
  logos: string[];
  themeColour: string | null;
  emails: { email: string; url: string }[];
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_BYTES = 1_500_000;

async function get(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-GB,en;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const html = (await res.text()).slice(0, MAX_BYTES);
    return { url: res.url || url, html };
  } catch {
    return null;
  }
}

export async function crawlSite(website: string): Promise<Crawl | null> {
  const start = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const home = (await get(start)) ?? (start.startsWith("https://") ? await get(start.replace("https://", "http://")) : null);
  if (!home) return null;

  const pages: CrawledPage[] = [{ url: home.url, title: pageTitle(home.html), text: pageText(home.html) }];
  const emails = publishedEmails(home.html).map((email) => ({ email, url: home.url }));

  for (const url of pickPages(internalLinks(home.html, home.url))) {
    const page = await get(url);
    if (!page) continue;
    pages.push({ url: page.url, title: pageTitle(page.html), text: pageText(page.html, 6000) });
    for (const email of publishedEmails(page.html)) emails.push({ email, url: page.url });
  }

  return {
    pages,
    logos: logoCandidates(home.html, home.url),
    themeColour: themeColour(home.html),
    emails,
  };
}
