import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/env";
import * as schema from "./schema";

/**
 * Drizzle over postgres-js, on Neon's pooled connection. Created on first use
 * so builds and scripts that never touch the database need no DATABASE_URL.
 * `prepare: false` because Neon's pooler (PgBouncer) does not keep prepared
 * statements between transactions.
 */
let client: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (client) return client;
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set (Vercel → Storage → Neon).");
  client = drizzle(postgres(env.DATABASE_URL, { prepare: false, max: 5 }), { schema });
  return client;
}
