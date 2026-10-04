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
  /** The campaign drafts are pushed into (npm run instantly:setup makes it). */
  INSTANTLY_CAMPAIGN_ID: optional,
  /** Our own shared secret: Instantly sends it as a header on every webhook. */
  INSTANTLY_WEBHOOK_SECRET: optional,
  /** This app's public address, for webhooks, e.g. https://promoter.macaws.ai */
  APP_URL: optional,
  TRIGGER_SECRET_KEY: optional,
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
