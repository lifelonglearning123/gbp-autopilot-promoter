import { z } from "zod";

/**
 * Validated environment, read lazily so `next build` needs no secrets.
 * Server code imports `env` from here instead of reading process.env.
 * Integrations not set up yet are optional; what needs them checks first.
 */
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  // Neon Postgres, added to the Vercel project from Storage.
  DATABASE_URL: optional,

  // GoHighLevel: the agency list (contacts tagged `ghl-agency`) and the CRM.
  ghl_token: optional,
  ghl_location: optional,

  // GBP Autopilot platform's bot API (gbp-platform, src/lib/bot).
  PLATFORM_URL: z.string().default("https://gbp.macaws.ai"),
  PLATFORM_BOT_API_KEY: optional,
  /** Signs the events the platform sends us (its BOT_WEBHOOK_SECRET). */
  PLATFORM_WEBHOOK_SECRET: optional,

  // Still to come: models, sending, jobs.
  OPENROUTER_API_KEY: optional,
  /** Research, reply sorting, draft checking, weekly review. Kimi direct, for cost. */
  ANALYSIS_MODEL: z.string().default("moonshotai/kimi-k3"),
  /** The copywriters, comma-separated; two or more are compared head to head. Kimi only, for cost. */
  WRITER_MODELS: z.string().default("moonshotai/kimi-k3"),
  /** Kimi direct (platform.moonshot.ai). When set, moonshotai/* models skip OpenRouter. */
  MOONSHOT_API_KEY: optional,
  MOONSHOT_BASE_URL: z.string().default("https://api.moonshot.ai/v1"),
  INSTANTLY_API_KEY: optional,
  /** Our tag in the shared Instantly workspace: only mailboxes carrying it are ours. */
  INSTANTLY_TAG: z.string().default("Signal"),
  /** Who sends, under every email: name and role, then the legal line (company, address). */
  SENDER_SIGNOFF: z.string().default("Chao\\nFounder, GBP Autopilot"),
  SENDER_LEGAL: optional,
  /** The campaign drafts are pushed into (npm run instantly:setup makes it). */
  INSTANTLY_CAMPAIGN_ID: optional,
  /** Our own shared secret: Instantly sends it as a header on every webhook. */
  INSTANTLY_WEBHOOK_SECRET: optional,
  /** This app's public address, for webhooks, e.g. https://promoter.macaws.ai */
  APP_URL: optional,
  TRIGGER_SECRET_KEY: optional,

  // Running on its own, with the owner informed and in control.
  /** Who is told what is going on, and can stop it. Alerts go by email through GHL. */
  OWNER_EMAIL: z.string().default("chao@macaws.ai"),
  /** Hours a new draft waits for the owner's veto before it is pushed. */
  HOLD_HOURS: z.coerce.number().default(24),
  /** Vercel Cron sends it as a bearer token. */
  CRON_SECRET: optional,
  /** Signs the stop / pause links in emails. */
  ACTION_SECRET: optional,
  /** The dashboard's password. */
  DASHBOARD_PASSWORD: optional,

  // YouTube creators posting about local SEO / Google Business Profile.
  /** Google Cloud API key with the YouTube Data API v3 enabled. */
  YOUTUBE_API_KEY: optional,
  /** What to search for, separated by "|". */
  YOUTUBE_QUERIES: z
    .string()
    .default(
      "google business profile|google business profile optimization|GMB ranking|google maps ranking|local SEO|local SEO for agencies|gohighlevel local SEO|google business profile agency|rank on google maps|google business profile reviews",
    ),
  /** The Instantly campaign for creators (its own copy and results). */
  INSTANTLY_YT_CAMPAIGN_ID: optional,
});

type Env = z.infer<typeof schema>;
let parsed: Env | null = null;

function load(): Env {
  if (parsed) return parsed;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  parsed = result.data;
  return parsed;
}

export const env = new Proxy({} as Env, {
  get(_target, key: string) {
    return load()[key as keyof Env];
  },
});
