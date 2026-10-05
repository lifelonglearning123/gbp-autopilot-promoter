import { timingSafeEqual } from "node:crypto";
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

/* ── Sending ─────────────────────────────────────────────────────────────── */

async function api<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(`Instantly ${method} ${path.split("?")[0]} ${res.status}: ${data.message ?? data.error ?? ""}`);
  return data;
}

/** A draft's plain text as the HTML Instantly sends: escaped, paragraphs and line breaks kept. */
export function bodyHtml(text: string): string {
  const esc = text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // One <div> per line, an empty line as <div><br /></div>: Instantly's editor
  // strips bare text and runs of <br/>.
  return esc
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `<div>${line}</div>` : "<div><br /></div>"))
    .join("");
}

/** Does a webhook carry our secret? Instantly signs nothing, so we set the header ourselves. */
export function webhookSecretOk(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const WEBHOOK_HEADER = "x-promoter-secret";

/**
 * The workspace is shared with another client (Outbound Console's set-up):
 * each client's mailboxes and campaigns carry its own tag. Ours is
 * INSTANTLY_TAG; nothing here ever uses a mailbox without it.
 */
export async function ourTagId(): Promise<string> {
  const body = await api<{ items?: { id: string; label: string }[] }>("GET", "/custom-tags?limit=100");
  const tag = (body.items ?? []).find((t) => t.label.toLowerCase() === env.INSTANTLY_TAG.toLowerCase());
  if (!tag) throw new Error(`No Instantly tag "${env.INSTANTLY_TAG}": our mailboxes must carry it.`);
  return tag.id;
}

/** Our mailboxes that can send now (status 1): only those with our tag. */
export async function sendingAccounts(tagId: string): Promise<string[]> {
  const body = await api<{ items?: { email: string; status?: number }[] }>("GET", `/accounts?limit=100&tag_ids=${tagId}`);
  return (body.items ?? []).filter((a) => a.status === 1).map((a) => a.email);
}

/** Put our tag on a campaign, so Outbound Console shows it under our client. */
export async function tagCampaign(tagId: string, campaignId: string) {
  await api("POST", "/custom-tags/toggle-resource", { tag_ids: [tagId], resource_type: 2, resource_ids: [campaignId], assign: true });
}

/** Send only from these mailboxes. */
export async function setCampaignAccounts(campaignId: string, accounts: string[]) {
  return api<{ email_list?: string[] }>("PATCH", `/campaigns/${campaignId}`, { email_list: accounts });
}

/**
 * One campaign for first emails. Each lead carries its own written email as
 * custom variables, so the sequence is just {{subject}} and {{body_html}}.
 * Created as a draft: nothing is sent until it is activated in Instantly.
 * Weekdays 9-5 UK time (Instantly has no Europe/London; Isle of Man keeps UK time).
 */
export async function createFirstEmailCampaign(name: string, accounts: string[]): Promise<{ id: string; status: number }> {
  return api("POST", "/campaigns", {
    name,
    campaign_schedule: {
      schedules: [
        {
          name: "UK weekdays",
          timing: { from: "09:00", to: "17:00" },
          days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
          timezone: "Europe/Isle_of_Man",
        },
      ],
    },
    sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: "{{subject}}", body: "{{body_html}}" }] }] }], // sign-off: setCampaignCopy
    email_list: accounts,
    daily_limit: 30,
    stop_on_reply: true,
    stop_for_company: true,
    open_tracking: false,
    link_tracking: false,
    insert_unsubscribe_header: true,
  });
}

/**
 * The email Instantly sends: the lead's own draft, then the same sign-off,
 * legal line and opt-out under every one (a cold email must say who sent it
 * and how to stop more).
 */
export function campaignBody(signoff: string, legal: string): string {
  const footer = `${signoff}\n\n${legal}\nNot relevant? Reply "remove" and I will take you off this list straight away.`;
  return `<div>{{body_html}}</div><div><br /></div>${bodyHtml(footer)}`;
}

export async function setCampaignCopy(campaignId: string, body: string) {
  return api<{ id: string }>("PATCH", `/campaigns/${campaignId}`, {
    sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: "{{subject}}", body }] }] }],
  });
}

export type NewLead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  website?: string;
  custom_variables: Record<string, string>;
};

/**
 * Up to 1000 leads into a campaign. People who were leads in an earlier
 * campaign are added too (a new offer): who must never be written to again is
 * settled before this, by suppression and Instantly's block list.
 */
export async function addLeads(campaignId: string, leads: NewLead[]) {
  return api<{
    leads_uploaded?: number;
    in_blocklist?: number;
    skipped_count?: number;
    duplicated_leads?: number;
    created_leads?: { index: number; id: string; email: string }[];
  }>("POST", "/leads/add", { campaign_id: campaignId, leads, skip_if_in_workspace: false, skip_if_in_campaign: false });
}

/** Instantly calls our webhook for every event in the campaign, with our secret header. */
export function createWebhook(campaignId: string, url: string, secret: string) {
  return api<{ id: string }>("POST", "/webhooks", {
    name: "gbp-promoter",
    target_hook_url: url,
    campaign: campaignId,
    event_type: "all_events",
    headers: { [WEBHOOK_HEADER]: secret },
  });
}

/** Never send to these again, from any campaign in the workspace. Emails or domains. */
export async function blockList(values: string[]) {
  if (values.length === 0) return;
  await api("POST", "/block-lists-entries/bulk-create", { bl_values: values.slice(0, 1000) });
}
