import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/**
 * The GBP Autopilot platform's bot API (gbp-platform, src/lib/bot).
 * Our key goes in `x-api-key`; the platform must have the same value as BOT_API_KEY.
 */

export type SampleResult = {
  title: string;
  address: string;
  score: number;
  coverage: number;
  verdict: string;
  gaps: { label: string; note: string }[];
  standing: string | null;
  rivalNote: string | null;
  opportunity: string | null;
};

export type Sample = {
  token: string;
  previewUrl: string;
  claimUrl: string | null;
  result: SampleResult;
  cached: boolean;
};

export type SampleRequest = (
  | { link: string }
  | { cid: string }
  | { name: string; town: string }
) & {
  brand: { name: string; logoUrl?: string | null; colour?: string | null };
  externalRef?: string;
  contact?: { email: string; fullName?: string };
  /** "creator": the claimed account is a content creator's — free, 40% of what its businesses pay, for life. */
  offer?: "creator";
};

export class PlatformError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, body: unknown): Promise<T> {
  if (!env.PLATFORM_BOT_API_KEY) throw new PlatformError(0, "PLATFORM_BOT_API_KEY is not set.");
  const res = await fetch(`${env.PLATFORM_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.PLATFORM_BOT_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new PlatformError(res.status, data.error ?? `Platform answered ${res.status}`);
  return data;
}

/** A sample audit in the prospect agency's brand, plus its preview and claim links. */
export function makeSample(req: SampleRequest): Promise<Sample> {
  return call<Sample>("/api/bot/sample", req);
}

/**
 * The claim link to put in an email: the platform's short /c/<sample token>,
 * which redirects to the signed signup link stored with the sample (that one
 * is several hundred characters). Null when the sample has no claim link.
 */
export function shortClaimUrl(sample: { claimUrl: string | null; platformToken: string }): string | null {
  return sample.claimUrl ? `${env.PLATFORM_URL.replace(/\/$/, "")}/c/${sample.platformToken}` : null;
}

/** A pre-filled signup link on its own (30 days), and its short /c/<token> form to put in an email. */
export function claimLink(req: {
  agencyName: string;
  /** Needed, except for a creator reached by DM: they type it at signup. */
  email?: string;
  fullName?: string;
  logoUrl?: string | null;
  colour?: string | null;
  externalRef?: string;
  offer?: "creator";
}): Promise<{ claimUrl: string; shortUrl?: string }> {
  return call("/api/bot/claim-link", req);
}

/** Did this event body really come from the platform? (`x-signature: sha256=<hex>`) */
export function signedByPlatform(rawBody: string, header: string | null, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
