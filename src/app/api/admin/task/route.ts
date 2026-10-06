import { after } from "next/server";
import { db } from "@/db/client";
import { events } from "@/db/schema";
import { env } from "@/env";
import { enableSequence, shortenClaimLinks, syncFollowUps } from "@/lib/followups";
import { backfillFollowUps } from "@/lib/pipeline";
import { discoverCreators, enrichCreators, handOverCreators, qualifyCreators, queueTasks } from "@/lib/creators";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * One-off campaign tasks run on the server (its connections to Instantly and
 * the database are steadier than a laptop's). Same secret as the cron.
 *   ?do=followups   write follow-ups for leads missing them
 *   ?do=sync        put follow-ups on the Instantly leads
 *   ?do=shorten     swap long claim links in unsent emails for short ones, then re-sync
 *   ?do=youtube     one round of YouTube: find, qualify, collect details, hand over, write DMs (nothing sent)
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
  else if (task === "shorten") {
    lines.push(`${await shortenClaimLinks()} emails now carry the short claim link`);
    await syncFollowUps(500, log);
  } else if (task === "youtube") {
    // Answers at once and works on after the reply (a long-held request gets dropped).
    // Work already sorted goes first, so a round always moves creators forward.
    after(async () => {
      await enrichCreators(30, log);
      await handOverCreators(30, log);
      await queueTasks(15, log);
      await discoverCreators(log);
      await qualifyCreators(24, log);
      await db().insert(events).values({ source: "bot", type: "run", payload: { lines: ["youtube round:", ...lines] } });
    });
    return Response.json({ ok: true, started: "youtube round" });
  } else if (task === "enable") lines.push(await enableSequence());
  else return Response.json({ error: "unknown task" }, { status: 400 });
  return Response.json({ ok: true, lines });
}
