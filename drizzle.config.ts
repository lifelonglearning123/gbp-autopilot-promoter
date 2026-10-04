import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// `generate` only reads the schema; `migrate` needs the real DATABASE_URL.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://placeholder@localhost:5432/placeholder" },
  strict: true,
  verbose: true,
});
