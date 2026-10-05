import { env } from "@/env";

/**
 * Email to the owner, sent through GoHighLevel (the sub-account's own email),
 * so no other mail service is needed. The owner is a contact there; found or
 * made by email the first time.
 */

const BASE = "https://services.leadconnectorhq.com";

function headers(version: string) {
  if (!env.ghl_token || !env.ghl_location) throw new Error("ghl_token and ghl_location must be set.");
  return { Authorization: `Bearer ${env.ghl_token}`, Version: version, "Content-Type": "application/json", Accept: "application/json" };
}

let ownerId: string | null = null;

async function ownerContactId(): Promise<string> {
  if (ownerId) return ownerId;
  const res = await fetch(`${BASE}/contacts/upsert`, {
    method: "POST",
    headers: headers("2021-07-28"),
    body: JSON.stringify({ locationId: env.ghl_location, email: env.OWNER_EMAIL, tags: ["gbp-promoter-owner"] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { contact?: { id?: string }; message?: string };
  if (!res.ok || !body.contact?.id) throw new Error(`GHL would not find the owner contact (${res.status}): ${body.message ?? ""}`);
  ownerId = body.contact.id;
  return ownerId;
}

export async function tellOwner(subject: string, html: string) {
  const contactId = await ownerContactId();
  const res = await fetch(`${BASE}/conversations/messages`, {
    method: "POST",
    headers: headers("2021-04-15"),
    body: JSON.stringify({ type: "Email", contactId, subject, html }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const why = ((await res.json().catch(() => ({}))) as { message?: string }).message;
    throw new Error(`GHL would not send the email (${res.status}): ${why ?? ""}`);
  }
}

/** Plain text made safe for an email's HTML. */
export function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
