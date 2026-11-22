import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { env } from "@/env";

/**
 * First emails written but not yet sent, for agencies or for creators: those
 * pushed and waiting in Instantly, and those still on hold. Drafting more than
 * a few days ahead of sending only writes emails that go stale, at a model
 * call each (2026-11-08: 80 creator sequences a day were written for about 20
 * sends a day). Anything older than three weeks is taken as stuck and not
 * counted, so drafting never waits on it for good.
 */
export async function firstEmailsWaiting(creatorsTrack: boolean): Promise<number> {
  const [{ n }] = (await db().execute(sql`
    select count(*)::int n from messages m join contacts c on c.id = m.contact_id
    where m.step = 1 and m.sent_at is null and m.stopped_at is null
      and (m.guardrail->>'ok')::boolean and c.email_status = 'valid'
      and m.created_at > now() - interval '21 days'
      and (c.source like 'partner:%') = ${creatorsTrack}`)) as unknown as { n: number }[];
  return n;
}

/** Null when drafting may go on; otherwise the line for the run's log. DRAFT_BACKLOG 0 turns it off. */
export async function backlogFull(creatorsTrack: boolean): Promise<string | null> {
  if (env.DRAFT_BACKLOG <= 0) return null;
  const waiting = await firstEmailsWaiting(creatorsTrack);
  return waiting >= env.DRAFT_BACKLOG
    ? `${creatorsTrack ? "creator" : "agency"} drafting held: ${waiting} first emails written and not yet sent (DRAFT_BACKLOG ${env.DRAFT_BACKLOG})`
    : null;
}
