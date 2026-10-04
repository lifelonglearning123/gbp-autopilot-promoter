import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// `generate` only reads the schema; `migrate` needs the real database. Schema
// changes go over Neon's direct connection, not the pooler.
const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.DATABASE_URL ??
  "postgresql://placeholder@localhost:5432/placeholder";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
