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

export function tidyEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
