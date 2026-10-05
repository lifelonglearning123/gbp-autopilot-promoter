import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { creators, outreachTasks } from "@/db/schema";
import { env } from "@/env";

/**
 * YouTube creators into the owner's GoHighLevel, where the work happens: a
 * contact (tagged youtube-creator) with every public detail, a note with the
 * drafted messages, and a task per DM or call on its due date. Ticking a task
 * done in the DM queue ticks it in GHL too.
 */

const BASE = "https://services.leadconnectorhq.com";

function headers() {
  if (!env.ghl_token || !env.ghl_location) throw new Error("ghl_token and ghl_location must be set.");
  return { Authorization: `Bearer ${env.ghl_token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`GHL ${method} ${path.split("?")[0]} ${res.status}: ${data.message ?? ""}`);
  return data;
}

const LABEL: Record<string, string> = { instagram: "Instagram DM", skool: "Skool DM", phone: "Call", youtube: "YouTube" };

export async function syncCreatorsToGhl(limit: number, log: (l: string) => void) {
  const todo = (await db().execute(sql`
    select cr.id from creators cr
    where cr.ghl_contact_id is null
      and exists (select 1 from outreach_tasks t where t.creator_id = cr.id)
    limit ${limit}`)) as unknown as { id: string }[];
  let n = 0;
  for (const { id } of todo) {
    const [c] = await db().select().from(creators).where(eq(creators.id, id)).limit(1);
    const tasks = await db().select().from(outreachTasks).where(eq(outreachTasks.creatorId, id));
    const email = c.emails[0]?.email;
    const phone = c.phones[0]?.phone;
    const up = await call<{ contact?: { id?: string } }>("POST", "/contacts/upsert", {
      locationId: env.ghl_location,
      name: c.title,
      companyName: c.title,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(c.links.website ? { website: c.links.website } : {}),
      tags: ["youtube-creator", `yt-${c.kind ?? "unknown"}`, ...(c.usesGhl ? ["uses-ghl"] : [])],
      source: "YouTube outreach (GBP Autopilot)",
    });
    const contactId = up.contact?.id;
    if (!contactId) continue;

    const details = [
      `YouTube: ${c.links.youtube ?? ""} (${c.subscribers ?? "?"} subscribers)`,
      `Why: ${c.qualifyNotes ?? ""} (fit ${c.fitScore ?? "?"}${c.usesGhl ? ", uses GHL" : ""})`,
      ...Object.entries(c.links)
        .filter(([k]) => k !== "youtube")
        .map(([k, v]) => `${k}: ${v}`),
      ...c.emails.map((e) => `email: ${e.email} (found on ${e.source})`),
      ...c.phones.map((p) => `phone: ${p.phone} (found on ${p.source})`),
      `Recent videos:`,
      ...c.recentVideos.slice(0, 5).map((v) => `- ${v.title}`),
      ``,
      ...tasks.map((t) => `${LABEL[t.channel] ?? t.channel} (${t.target}), due ${t.dueAt.toISOString().slice(0, 10)}:\n${t.message}`),
    ].join("\n");
    await call("POST", `/contacts/${contactId}/notes`, { body: details });
    for (const t of tasks) {
      const task = await call<{ task?: { id?: string }; id?: string }>("POST", `/contacts/${contactId}/tasks`, {
        title: `${LABEL[t.channel] ?? t.channel}: ${c.title}`,
        body: `${t.target}\n\n${t.message}`,
        dueDate: t.dueAt.toISOString(),
        completed: false,
      });
      const taskId = task.task?.id ?? task.id;
      if (taskId) await db().update(outreachTasks).set({ ghlTaskId: taskId }).where(eq(outreachTasks.id, t.id));
    }
    await db().update(creators).set({ ghlContactId: contactId, updatedAt: new Date() }).where(eq(creators.id, id));
    n++;
  }
  if (n) log(`youtube: ${n} creators added to GHL with their tasks`);
}

/** Tick the GHL task when the queue marks it done or skipped. */
export async function completeGhlTask(taskId: string) {
  const [t] = await db().select().from(outreachTasks).where(and(eq(outreachTasks.id, taskId), isNull(outreachTasks.ghlTaskId))).limit(1);
  if (t) return; // never went to GHL
  const [row] = (await db().execute(sql`
    select t.ghl_task_id, cr.ghl_contact_id from outreach_tasks t join creators cr on cr.id = t.creator_id where t.id = ${taskId}`)) as unknown as {
    ghl_task_id: string | null;
    ghl_contact_id: string | null;
  }[];
  if (!row?.ghl_task_id || !row.ghl_contact_id) return;
  await call("PUT", `/contacts/${row.ghl_contact_id}/tasks/${row.ghl_task_id}/completed`, { completed: true }).catch(() => {});
}
