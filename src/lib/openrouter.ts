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
 */

export type Usage = { model: string; promptTokens: number; completionTokens: number; costUsd: number | null };

export async function askJson<T>(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<{ data: T; usage: Usage }> {
  const direct = opts.model.startsWith("moonshotai/") && !!env.MOONSHOT_API_KEY;
  if (!direct && !env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");
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
        body: JSON.stringify({ model: opts.model.slice("moonshotai/".length), ...common, max_tokens: common.max_tokens + 6000 }),
        signal: AbortSignal.timeout(120_000),
      })
    : await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          ...common,
          provider: { data_collection: "deny", zdr: true },
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(120_000),
      });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    model?: string;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`${direct ? "Moonshot" : "OpenRouter"} ${res.status}: ${body.error?.message ?? "no message"}`);
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
    usage: {
      model: body.model ?? opts.model,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd: body.usage?.cost ?? null,
    },
  };
}
