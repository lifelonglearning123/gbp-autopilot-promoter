/** Do the API keys work, and are the models there? Prints statuses only, never keys. */
import { env } from "../src/env";

async function main() {
  const models = (await (await fetch("https://openrouter.ai/api/v1/models")).json()) as { data: { id: string }[] };
  const ids = new Set(models.data.map((m) => m.id));
  for (const id of ["anthropic/claude-sonnet-5.5", "moonshotai/kimi-k3", "openai/gpt-5.5"]) {
    console.log(`model ${id}: ${ids.has(id) ? "available" : "NOT FOUND"}`);
  }

  const or = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
  console.log(`OpenRouter key: ${or.status === 200 ? "works" : `HTTP ${or.status}`}`);

  const ins = await fetch("https://api.instantly.ai/api/v2/accounts?limit=50", {
    headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}` },
  });
  const insBody = (await ins.json().catch(() => ({}))) as { items?: { status?: number; warmup_status?: number }[] };
  console.log(
    `Instantly key: ${ins.status === 200 ? "works" : `HTTP ${ins.status}`}` +
      (insBody.items ? `, sending accounts: ${insBody.items.length}` : ""),
  );
  console.log(`Trigger.dev key: ${env.TRIGGER_SECRET_KEY ? (env.TRIGGER_SECRET_KEY.startsWith("tr_dev_") ? "set (dev)" : env.TRIGGER_SECRET_KEY.startsWith("tr_prod_") ? "set (prod)" : "set") : "missing"}`);
}
main();
