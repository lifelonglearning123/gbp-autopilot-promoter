import { env } from "@/env";

/**
 * Instantly API v2. For now, email verification (one credit per address).
 * https://developer.instantly.ai/api-reference/emailverification/create-email-verification
 */

const BASE = "https://api.instantly.ai/api/v2";

export type Verified = "valid" | "risky" | "invalid" | "pending";

function headers() {
  if (!env.INSTANTLY_API_KEY) throw new Error("INSTANTLY_API_KEY is not set.");
  return { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "Content-Type": "application/json" };
}

/**
 * Instantly's verdict, folded to ours. Catch-all domains accept every address,
 * so a "valid" there proves nothing: it is risky, and risky is not sent to in
 * the main sequence.
 */
export function foldVerdict(v: { verification_status?: string; catch_all?: boolean | string }): Verified {
  const s = (v.verification_status ?? "").toLowerCase();
  if (s === "pending") return "pending";
  if (s === "verified" || s === "valid") return v.catch_all === true || v.catch_all === "yes" ? "risky" : "valid";
  if (s === "invalid") return "invalid";
  return "risky";
}

export async function verifyEmail(email: string): Promise<Verified> {
  const res = await fetch(`${BASE}/email-verification`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const why = ((await res.json().catch(() => ({}))) as { message?: string }).message;
    throw new Error(`Instantly verification ${res.status}${why ? `: ${why}` : ""}`);
  }
  return foldVerdict(await res.json());
}

/** For an address that came back pending: ask again. */
export async function verificationStatus(email: string): Promise<Verified> {
  const res = await fetch(`${BASE}/email-verification/${encodeURIComponent(email)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Instantly verification status ${res.status}`);
  return foldVerdict(await res.json());
}
