import { env } from "@/env";
import { enableSequence, syncFollowUps } from "@/lib/followups";
import { backfillFollowUps } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * One-off campaign tasks run on the server (its connections to Instantly and
 * the database are steadier than a laptop's). Same secret as the cron.
 *   ?do=followups   write follow-ups for leads missing them
 *   ?do=sync        put follow-ups on the Instantly leads
 *   ?do=enable      switch the campaign to the four-step sequence (refuses if any active lead lacks them)
 */
export async function POST(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const task = new URL(req.url).searchParams.get("do");
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  if (task === "followups") await backfillFollowUps(50, Date.now() + 700_000, log);
  else if (task === "sync") await syncFollowUps(500, log);
  else if (task === "enable") lines.push(await enableSequence());
  else return Response.json({ error: "unknown task" }, { status: 400 });
  return Response.json({ ok: true, lines });
}
