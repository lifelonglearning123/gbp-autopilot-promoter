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
  INSTANTLY_API_KEY: optional,
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
