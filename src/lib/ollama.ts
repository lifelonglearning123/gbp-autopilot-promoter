import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * The local model (Ollama on the owner's PC). Research runs here instead of on
 * Kimi: it costs nothing, but it only exists while that PC is on, so only
 * scripts on the PC call it — never the Vercel cron.
 */

export const LOCAL_MODEL = process.env.LOCAL_MODEL ?? "qwen3:30b-a3b";
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";

const up = () => fetch(`${OLLAMA}/api/version`).then((r) => r.ok).catch(() => false);

/** Start the Ollama server if it is not answering, and wait up to a minute for it. */
export async function startOllama(): Promise<boolean> {
  if (await up()) return true;
  const exe = join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe");
  spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    if (await up()) return true;
  }
  return false;
}

async function once<T>(system: string, user: string): Promise<T> {
  // Streamed, so a slow answer is never cut off by a headers timeout.
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model: LOCAL_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      format: "json",
      think: false,
      stream: true,
      options: { num_ctx: 12288, temperature: 0.2 },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}`);
  let text = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(`Ollama: ${j.error}`);
      text += j.message?.content ?? "";
    }
  }
  return JSON.parse(text) as T;
}

/** Ask the local model for JSON. Starts Ollama if needed and tries three times. */
export async function askLocalJson<T>(system: string, user: string): Promise<{ data: T; model: string }> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { data: await once<T>(system, user), model: `ollama:${LOCAL_MODEL}` };
    } catch (e) {
      last = e;
      await startOllama();
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
