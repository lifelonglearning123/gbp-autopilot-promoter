/**
 * Pure rules for contacts and agencies, pinned by scripts/verify.ts.
 */

/** Consumer mailboxes. An agency writing from one is likely a sole trader. */
const FREE_MAIL =
  /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|protonmail|proton|gmx|zoho|btinternet|btopenworld|sky|virginmedia|talktalk|ntlworld|blueyonder|tiscali|orange|mail)\.[a-z.]+$/i;

export type EmailType = "work" | "free";

export function emailType(email: string): EmailType {
  return FREE_MAIL.test(email.trim()) ? "free" : "work";
}

/** "https://www.Acme-Digital.co.uk/about?x=1" → "acme-digital.co.uk"; null if it is not a web address. */
export function domainOf(website: string | null | undefined): string | null {
  const raw = (website ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/**
 * The agency's key: its website's domain, else its work email's domain.
 * A free-mail domain is never a key (thousands of agencies share gmail.com),
 * so a contact with only that falls back to the email itself.
 */
export function agencyKey(website: string | null | undefined, email: string): string {
  const fromSite = domainOf(website);
  if (fromSite) return fromSite;
  const at = email.trim().toLowerCase().split("@")[1] ?? "";
  return emailType(email) === "work" && at ? at : `email:${email.trim().toLowerCase()}`;
}

/** A site's title and description read like a marketing agency's; the research model makes the real call. */
export function looksLikeAgency(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(recruit\w*|estate agen\w*|letting agen\w*|lettings|travel agen\w*|care agency|home care|nursing|staffing|employment agency|model(l)?ing agency|talent agency|insurance|mortgage|solicitors?)\b/.test(t)) return false;
  return /\b(marketing|agency|digital|seo|web ?design|website design|websites|ppc|lead gen\w*|advertising|branding|social media|funnels?)\b/.test(t);
}

/** Addresses nobody reads, or that belong to a team we should not cold-email. */
const NOT_A_PERSON = /^(no-?reply|do-?not-?reply|privacy|dpo|gdpr|legal|abuse|postmaster|webmaster|careers|jobs|recruitment|accounts|invoices|billing|unsubscribe)@/;
const SHARED = /^(info|hello|hi|contact|enquiries|enquiry|office|admin|team|mail|sales|support|studio)@/;

/**
 * The address to write to, from those an agency's own site publishes: a
 * person at its domain, else a shared inbox at its domain. Another company's
 * address is never taken, nor a free-mail one: that is usually a sole trader,
 * whom UK PECR does not let us cold-email without consent.
 */
export function pickSiteEmail(emails: string[], domain: string): string | null {
  const tidy = [...new Set(emails.map(tidyEmail).filter((e): e is string => !!e && !NOT_A_PERSON.test(e)))];
  const own = tidy.filter((e) => {
    const at = e.split("@")[1];
    return at === domain || at.endsWith(`.${domain}`) || domain.endsWith(`.${at}`);
  });
  const person = own.find((e) => !SHARED.test(e));
  if (person) return person;
  return own[0] ?? null;
}

export function tidyEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
