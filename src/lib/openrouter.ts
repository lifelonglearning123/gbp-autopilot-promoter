import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { events } from "@/db/schema";
import { env } from "@/env";

/**
 * One way to call a model: OpenRouter's chat API, asking for JSON.
 *
 * Every request is routed only to providers that neither train on prompts nor
 * keep them (`data_collection: "deny"`, `zdr: true`), because prompts carry
 * agency research and a contact's first name. Never email addresses or lists.
 *
 * Kimi models ("moonshotai/…") go to Moonshot directly instead when
 * MOONSHOT_API_KEY is set: same chat API, the model id without the prefix.
 * Moonshot's own terms apply to those prompts, not OpenRouter's routing rules.
 *
 * Cost (the owner's ask, 2026-11-08, after the account ran dry unnoticed):
 * - Kimi K3 always thinks, and Moonshot's default effort is "max". Thinking is
 *   billed as output and was most of the spend, so every call says how hard to
 *   think: "low" unless the caller asks for more.
 * - Every call is kept as a model.usage event (step, tokens, dollars), for the
 *   dashboard and the daily summary.
 * - Past MODEL_DAILY_USD in a UTC day, calls are refused before they are made.
 *   The error says "daily budget", which failure-rules.ts counts as temporary:
 *   the step stops and the next day carries on, and nothing is set aside.
 */

export type Usage = { model: string; promptTokens: number; completionTokens: number; costUsd: number | null };
export type Effort = "low" | "high" | "max";

/** Today's spend so far, read from the events at most once a minute and added to as calls are made. */
let spent: { day: string; usd: number; readAt: number } | null = null;

export async function spentToday(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  if (spent && spent.day === day && Date.now() - spent.readAt < 60_000) return spent.usd;
  const [row] = (await db().execute(sql`
    select coalesce(sum((payload->>'usd')::numeric), 0)::float usd from events
    where type = 'model.usage' and at >= ${`${day}T00:00:00Z`}::timestamptz`)) as unknown as { usd: number }[];
  spent = { day, usd: Number(row?.usd ?? 0), readAt: Date.now() };
  return spent.usd;
}

/** Dollars for a call, from the provider's figure or the list prices. */
export function callCost(u: { promptTokens: number; cachedTokens: number; completionTokens: number; reported: number | null }): number {
  if (u.reported !== null) return u.reported;
  const fresh = Math.max(0, u.promptTokens - u.cachedTokens);
  return (fresh * env.MODEL_PRICE_IN + u.cachedTokens * env.MODEL_PRICE_CACHED + u.completionTokens * env.MODEL_PRICE_OUT) / 1_000_000;
}

export async function askJson<T>(opts: {
  model: string;
  /** Which step is asking, for the usage record: "research", "creator qualify"… */
  step: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** How hard a thinking model thinks. Low unless the work needs it. */
  effort?: Effort;
}): Promise<{ data: T; usage: Usage }> {
  if (env.MODEL_DAILY_USD > 0) {
    const usd = await spentToday();
    if (usd >= env.MODEL_DAILY_USD) {
      throw new Error(`Model daily budget reached: $${usd.toFixed(2)} of $${env.MODEL_DAILY_USD} spent today (MODEL_DAILY_USD).`);
    }
  }
  const direct = opts.model.startsWith("moonshotai/") && !!env.MOONSHOT_API_KEY;
  if (!direct && !env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");
  const effort = opts.effort ?? "low";
  const common = {
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    response_format: { type: "json_object" },
    max_tokens: opts.maxTokens ?? 2000,
  };
  const res = direct
    ? await fetch(`${env.MOONSHOT_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.MOONSHOT_API_KEY}`, "Content-Type": "application/json" },
        // Kimi thinks before answering, and the thinking counts against max_tokens.
        body: JSON.stringify({
          model: opts.model.slice("moonshotai/".length),
          ...common,
          max_tokens: common.max_tokens + 6000,
          reasoning_effort: effort,
        }),
        signal: AbortSignal.timeout(120_000),
      })
    : await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          ...common,
          reasoning: { effort },
          provider: { data_collection: "deny", zdr: true },
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(120_000),
      });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      cached_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
    model?: string;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`${direct ? "Moonshot" : "OpenRouter"} ${res.status}: ${body.error?.message ?? "no message"}`);

  // Kept before the answer is read: a reply cut off at max_tokens was still paid for.
  const u = body.usage ?? {};
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  const usd = callCost({ promptTokens, cachedTokens, completionTokens, reported: typeof u.cost === "number" ? u.cost : null });
  if (spent) spent.usd += usd;
  await db()
    .insert(events)
    .values({
      source: "bot",
      type: "model.usage",
      payload: {
        step: opts.step,
        model: body.model ?? opts.model,
        effort,
        prompt: promptTokens,
        cached: cachedTokens,
        completion: completionTokens,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? null,
        usd: Math.round(usd * 1e6) / 1e6,
      },
    })
    .catch(() => {});

  const text = body.choices?.[0]?.message?.content ?? "";
  // Some models wrap JSON in a fence despite being asked not to.
  const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let data: T;
  try {
    data = JSON.parse(json) as T;
  } catch {
    const cut = body.choices?.[0]?.finish_reason === "length" ? " (cut off at max_tokens)" : "";
    throw new Error(`${opts.model} did not return JSON${cut}.`);
  }
  return {
    data,
    usage: { model: body.model ?? opts.model, promptTokens, completionTokens, costUsd: usd },
  };
}
