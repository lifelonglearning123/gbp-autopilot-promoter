import { env } from "@/env";
import { tellOwner } from "@/lib/notify";
import { dailySummaryHtml } from "@/lib/summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The owner's daily email (vercel.json, 07:00 UTC). */
export async function GET(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { subject, html } = await dailySummaryHtml();
  await tellOwner(subject, html);
  return Response.json({ ok: true, subject });
}
