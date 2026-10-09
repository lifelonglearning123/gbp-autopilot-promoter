import { env } from "@/env";
import { tellOwner } from "@/lib/notify";
import { dailySummaryHtml, weeklyResults, weeklyResultsHtml } from "@/lib/summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The owner's daily email (vercel.json, 07:00 UTC). */
export async function GET(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { subject, html } = await dailySummaryHtml();
  await tellOwner(subject, html);
  // Mondays: the weekly results as well.
  if (new Date().getUTCDay() === 1) {
    const w = await weeklyResults();
    const sum = (k: "emailed" | "opened" | "replied" | "signed_up") => w.campaigns.reduce((a, r) => a + r[k], 0);
    await tellOwner(
      `Weekly results: ${sum("emailed")} emailed, ${sum("opened")} opened the audit, ${sum("replied")} replied, ${sum("signed_up")} signed up (8 weeks)`,
      `<div style="font-family:Arial,sans-serif;max-width:900px"><h2 style="margin:0 0 8px">GBP Autopilot outreach — weekly results</h2>${await weeklyResultsHtml()}</div>`,
    );
  }
  return Response.json({ ok: true, subject });
}
