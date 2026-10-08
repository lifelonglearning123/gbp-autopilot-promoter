// Copy the settings the app needs from .env.local into the linked Vercel project (Production),
// without printing them. Run after `vercel link`:   npm run vercel:env
// Existing values with the same name are replaced.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const KEYS = [
  "DATABASE_URL",
  "ghl_token",
  "ghl_location",
  "PLATFORM_URL",
  "PLATFORM_BOT_API_KEY",
  "PLATFORM_WEBHOOK_SECRET",
  "MOONSHOT_API_KEY",
  "OPENROUTER_API_KEY",
  "INSTANTLY_API_KEY",
  "INSTANTLY_TAG",
  "INSTANTLY_CAMPAIGN_ID",
  "INSTANTLY_US_CAMPAIGN_ID",
  "INSTANTLY_WEBHOOK_SECRET",
  "INSTANTLY_YT_CAMPAIGN_ID",
  "INSTANTLY_PARTNER_CAMPAIGN_ID",
  "YOUTUBE_API_KEY",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "HIGHLEVEL_COUNTRIES",
  "HIGHLEVEL_DAILY",
  "SENDER_LEGAL",
  "APP_URL",
  "OWNER_EMAIL",
  "CRON_SECRET",
  "ACTION_SECRET",
  "DASHBOARD_PASSWORD",
];

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_]+=/.test(l))
    .map((l) => {
      const v = l.slice(l.indexOf("=") + 1);
      return [l.slice(0, l.indexOf("=")), v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v];
    }),
);

for (const key of KEYS) {
  if (!env[key]) {
    console.log(`${key}: not in .env.local, skipped`);
    continue;
  }
  spawnSync("npx", ["vercel", "env", "rm", key, "production", "--yes"], { shell: true, stdio: "ignore" });
  // On stdin with no trailing newline, so it arrives exactly as written.
  const r = spawnSync("npx", ["vercel", "env", "add", key, "production"], { shell: true, input: env[key], stdio: ["pipe", "ignore", "pipe"] });
  console.log(`${key}: ${r.status === 0 ? "set" : `failed (${r.stderr.toString().trim().split("\n").pop()})`}`);
}
