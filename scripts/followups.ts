/**
 * Follow-ups (steps 2-4) for leads already in the campaign, then switch the
 * campaign to the whole sequence.
 *   npm run followups                    draft them for pushed leads that have none (--parallel 4)
 *   npm run followups -- --redo          write them again for every pushed lead (none sent yet)
 *   npm run followups -- --sync          put each lead's follow-ups on its Instantly lead
 *   npm run followups -- --enable        check every active lead has all four, then set the sequence
 * Prints counts and agency names only.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { env } from "../src/env";
import { draftFollowUps, followUpVars } from "../src/lib/followups";
import { bodyHtml, campaignLeads, sequenceSteps, setCampaignSequence, setLeadVars } from "../src/lib/instantly";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) || fallback : fallback;
};

async function draftAll() {
  const todo = (await db().execute(sql`
    select m.contact_id id, a.name from messages m
    join contacts c on c.id = m.contact_id join agencies a on a.id = c.agency_id
    where m.step = 1 and m.pushed_at is not null
      and (${process.argv.includes("--redo")} or not exists (select 1 from messages f where f.contact_id = m.contact_id and f.step = 2))
      and not exists (select 1 from messages s where s.contact_id = m.contact_id and s.step >= 2 and s.sent_at is not null)`)) as unknown as { id: string; name: string }[];
  const queue = [...todo];
  const tally: Record<string, number> = {};
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, arg("--parallel", 4)) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        let line: string;
        try {
          const r = await draftFollowUps(t.id);
          const k = !r.ok ? r.why : r.template ? "template" : "written";
          tally[k] = (tally[k] ?? 0) + 1;
          line = `${k.padEnd(9)} ${t.name}`;
        } catch (e) {
          tally.error = (tally.error ?? 0) + 1;
          line = `error     ${t.name}: ${e instanceof Error ? e.message : e}`;
        }
        console.log(`[${++done}/${todo.length}] ${line}`);
      }
    }),
  );
  console.log(`\n${todo.length} leads:`, JSON.stringify(tally));
}

async function sync() {
  const rows = (await db().execute(sql`
    select m.id, m.contact_id, m.subject, m.body, m.instantly_lead_id from messages m
    where m.step = 1 and m.instantly_lead_id is not null`)) as unknown as {
    id: string;
    contact_id: string;
    subject: string;
    body: string;
    instantly_lead_id: string;
  }[];
  let set = 0;
  let missing = 0;
  for (const r of rows) {
    const vars = await followUpVars(r.contact_id, bodyHtml);
    if (!vars) {
      missing++;
      continue;
    }
    await setLeadVars(r.instantly_lead_id, { subject: r.subject, body_html: bodyHtml(r.body), message_id: r.id, ...vars });
    set++;
  }
  console.log(`Instantly leads updated: ${set}; without follow-ups yet: ${missing}`);
}

async function enable() {
  const campaignId = env.INSTANTLY_CAMPAIGN_ID;
  if (!campaignId || !env.SENDER_LEGAL) throw new Error("INSTANTLY_CAMPAIGN_ID and SENDER_LEGAL must be set.");
  // Any lead still to get a step must have every email, or Instantly would send an empty one.
  const leads = await campaignLeads(campaignId);
  const active = leads.filter((l) => l.status === 1);
  const lacking = active.filter((l) => !["body_2_html", "body_3_html", "body_4_html"].every((k) => String(l.payload?.[k] ?? "").trim()));
  if (lacking.length) {
    console.log(`Not enabled: ${lacking.length} of ${active.length} active leads lack follow-ups. Run --sync first.`);
    return;
  }
  const lines = (s: string) => s.replace(/\\n/g, "\n");
  await setCampaignSequence(campaignId, sequenceSteps(lines(env.SENDER_SIGNOFF), lines(env.SENDER_LEGAL)));
  console.log(`Sequence on: day 0, 3, 7, 14 for ${active.length} active leads.`);
}

const run = process.argv.includes("--sync") ? sync : process.argv.includes("--enable") ? enable : draftAll;
run().then(() => process.exit(0));
