/**
 * What kind of failure stopped a draft: the ACCOUNT, something TEMPORARY, or
 * the ITEM itself.
 *
 * From 14:11 on 10 October 2026 every draft failed with "Moonshot 429: Your
 * account … is suspended due to insufficient balance". Nothing told them
 * apart, so the creator step re-picked the same ten creators every hour for
 * ten days (each asking the platform for a sample first), the sixty behind
 * them never got a turn, and the agency step's failures were swallowed by
 * `pool` without a line in the log. The three kinds need three answers:
 *
 * - account: stop the step and say so, loudly. Setting the creator aside
 *   would empty the queue for a fault that is ours.
 * - temporary: stop this run; the next one tries again.
 * - item: set that creator or agency aside (SET_ASIDE_DAYS) and move on.
 *
 * Pure; pinned in scripts/verify.ts.
 */

export type FailureKind = "account" | "temporary" | "item";

/** Out of money, out of quota, or no working key: nothing will succeed until a person acts. */
const ACCOUNT =
  /insufficient balance|insufficient credits?|exceeded_current_quota|quota exceeded|exceeded your (current )?quota|account (is )?suspended|is suspended|billing|payment required|invalid (api )?key|incorrect api key|is not set\./i;
/** Worth trying again in an hour. */
const TEMPORARY = /rate limit|too many requests|timed? ?out|aborted|fetch failed|econnreset|enotfound|socket hang up|overloaded|temporarily|unavailable|bad gateway/i;

export function failureKind(e: unknown): FailureKind {
  const message = e instanceof Error ? e.message : String(e ?? "");
  if (ACCOUNT.test(message)) return "account";
  // The platform (PlatformError carries its HTTP status): its key refused,
  // its own limits or a fault on its side are not this business's doing.
  const status = typeof e === "object" && e !== null && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : null;
  if (status !== null) {
    if (status === 401 || status === 402 || status === 403) return "account";
    if (status === 0 || status === 429 || status >= 500) return "temporary";
    return "item";
  }
  // A model provider's own status, as askJson writes it: "Moonshot 429: …".
  const code = /\b(?:OpenRouter|Moonshot) (\d{3}):/.exec(message)?.[1];
  if (code) {
    const n = Number(code);
    if (n === 401 || n === 402 || n === 403) return "account";
    if (n === 408 || n === 429 || n >= 500) return "temporary";
  }
  if (TEMPORARY.test(message)) return "temporary";
  return "item";
}

/** A creator or agency set aside after a failed draft is tried again after this long. */
export const SET_ASIDE_DAYS = 7;
/** A refusal recorded this recently is still news on the dashboard and in the summary. */
export const REFUSAL_FRESH_HOURS = 2;
