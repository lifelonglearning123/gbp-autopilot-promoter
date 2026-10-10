import { env } from "@/env";

/**
 * GoHighLevel v2: reading the agency list. Keys come from the environment
 * (ghl_token, ghl_location) and are never logged.
 */

const BASE = "https://services.leadconnectorhq.com";

export type GhlContact = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  website?: string | null;
  country?: string | null;
  source?: string | null;
  dnd?: boolean | null;
  validEmail?: boolean | null;
  tags?: string[];
};

function headers() {
  if (!env.ghl_token || !env.ghl_location) throw new Error("ghl_token and ghl_location must be set in .env.local.");
  return {
    Authorization: `Bearer ${env.ghl_token}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** Every contact carrying `tag`, 100 at a time. */
export async function contactsTagged(tag: string): Promise<GhlContact[]> {
  const all: GhlContact[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${BASE}/contacts/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        locationId: env.ghl_location,
        page,
        pageLimit: 100,
        filters: [{ field: "tags", operator: "contains", value: [tag] }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GHL contacts/search answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { contacts?: GhlContact[] };
    const batch = data.contacts ?? [];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

export type GhlVerdict = {
  result?: string;
  risk?: string;
  reason?: string[];
  leadconnectorRecomendation?: { isEmailValid?: boolean };
};

/**
 * GHL's verdict folded to ours (valid | risky | invalid). Catch-all ("accept
 * all") domains take any address, so "deliverable" there proves nothing and is
 * risky. Role addresses (info@, hello@) are fine for agencies: often the only
 * published inbox, and the right one for a business.
 */
export function foldGhlVerdict(v: GhlVerdict): "valid" | "risky" | "invalid" {
  const result = (v.result ?? "").toLowerCase();
  const risk = (v.risk ?? "").toLowerCase();
  const reasons = (v.reason ?? []).map((r) => r.toLowerCase());
  if (v.leadconnectorRecomendation?.isEmailValid === false || result === "undeliverable") return "invalid";
  if (reasons.some((r) => /accept_all|catch_all|disposable/.test(r))) return "risky";
  if (result === "deliverable" && (risk === "low" || risk === "")) return "valid";
  return "risky";
}

/** Verify one address with GHL's email verification (paid from the location's wallet). */
export async function verifyEmailGhl(email: string): Promise<"valid" | "risky" | "invalid"> {
  const res = await fetch(`${BASE}/email/verify?locationId=${env.ghl_location}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ type: "email", verify: email }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const why = ((await res.json().catch(() => ({}))) as { message?: string }).message;
    throw new Error(`GHL verification ${res.status}${why ? `: ${why}` : ""}`);
  }
  return foldGhlVerdict((await res.json()) as GhlVerdict);
}

/* ── Verification tags ──────────────────────────────────────────────────── */

/**
 * The owner's rule (2026-10-08): every address is checked with Instantly's
 * verification before it is used, and its GHL contact carries the answer.
 * Catch-all and invalid addresses are both "not verified".
 */
export const TAG_VERIFIED = "email verified";
export const TAG_NOT_VERIFIED = "email not verified";

export function verificationTag(status: string): string | null {
  if (status === "valid") return TAG_VERIFIED;
  if (status === "risky" || status === "invalid") return TAG_NOT_VERIFIED;
  return null; // unverified or pending: no answer yet
}

async function ghl<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`GHL ${method} ${path.split("?")[0]} ${res.status}: ${data.message ?? ""}`);
  return data;
}

/** The owner's existing GHL contact with this email (or, failing that, phone), if there is one. */
export async function findGhlContact(email?: string | null, phone?: string | null): Promise<string | null> {
  for (const [k, v] of [["email", email], ["number", phone]] as const) {
    if (!v) continue;
    const r = await ghl<{ contact?: { id?: string } | null }>(
      "GET",
      `/contacts/search/duplicate?locationId=${env.ghl_location}&${k}=${encodeURIComponent(v)}`,
    );
    if (r.contact?.id) return r.contact.id;
  }
  return null;
}

/**
 * The GHL contact for an address: the owner's existing one, untouched, or a
 * new one. An existing contact is never updated here — an upsert overwrote the
 * source and company of a contact the owner had since 2025 (2026-10-10) — so
 * callers only ADD tags and notes to it.
 */
export async function upsertGhlContact(c: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  website?: string | null;
}): Promise<string> {
  const existing = await findGhlContact(c.email);
  if (existing) return existing;
  const up = await ghl<{ contact?: { id?: string } }>("POST", "/contacts/upsert", {
    locationId: env.ghl_location,
    email: c.email,
    ...(c.firstName ? { firstName: c.firstName } : {}),
    ...(c.lastName ? { lastName: c.lastName } : {}),
    ...(c.companyName ? { companyName: c.companyName } : {}),
    ...(c.website ? { website: c.website } : {}),
    source: "GBP Autopilot promoter",
  });
  if (!up.contact?.id) throw new Error("GHL upsert gave no contact id");
  return up.contact.id;
}

/** Put the verification tag on a GHL contact and take the other one off. */
export async function setVerificationTag(ghlContactId: string, tag: string) {
  const other = tag === TAG_VERIFIED ? TAG_NOT_VERIFIED : TAG_VERIFIED;
  await ghl("POST", `/contacts/${ghlContactId}/tags`, { tags: [tag] });
  await ghl("DELETE", `/contacts/${ghlContactId}/tags`, { tags: [other] }).catch(() => {});
}
