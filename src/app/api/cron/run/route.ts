import { env } from "@/env";
import { hourlyRun } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * The hourly run (vercel.json): replies, safety check, push drafts whose hold
 * has passed, then intake, research and drafting while time is left.
 * Vercel Cron sends CRON_SECRET as a bearer token.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const lines = await hourlyRun(650_000);
  return Response.json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), lines });
}
