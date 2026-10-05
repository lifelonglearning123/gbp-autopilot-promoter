import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { messageLink } from "@/lib/creator-rules";
import { isOwner, queueAction } from "../actions";
import { CopyOpen } from "./copy-open";

export const dynamic = "force-dynamic";

const OPEN: Record<string, string> = { instagram: "Copy & open Instagram", skool: "Copy & open Skool", phone: "Copy script & call", youtube: "Open YouTube" };

/**
 * The DM queue: messages a person sends by hand (Instagram, Skool, calls), due
 * now. Built for a phone: tap to copy and open, send, tick Done.
 */
export default async function Queue() {
  if (!(await isOwner())) {
    return (
      <main style={{ maxWidth: 380, margin: "60px auto", padding: "0 16px", fontFamily: "Arial, sans-serif" }}>
        <p>
          Log in on the <a href="/dashboard">dashboard</a> first.
        </p>
      </main>
    );
  }
  const due = (await db().execute(sql`
    select t.id, t.channel, t.target, t.message, t.due_at, cr.title, cr.subscribers, cr.links->>'youtube' youtube,
           cr.recent_videos->0->>'title' latest
    from outreach_tasks t join creators cr on cr.id = t.creator_id
    where t.done_at is null and t.skipped_at is null and t.replied_at is null and t.due_at <= now()
    order by t.due_at limit 50`)) as unknown as {
    id: string;
    channel: "instagram" | "skool" | "phone" | "youtube";
    target: string;
    message: string;
    due_at: string;
    title: string;
    subscribers: number | null;
    youtube: string | null;
    latest: string | null;
  }[];
  const [later] = (await db().execute(sql`
    select count(*)::int n from outreach_tasks where done_at is null and skipped_at is null and replied_at is null and due_at > now()`)) as unknown as { n: number }[];
  const btn = { padding: "8px 12px", fontSize: 14, cursor: "pointer", marginRight: 6 };

  return (
    <main style={{ maxWidth: 560, margin: "24px auto", padding: "0 12px", fontFamily: "Arial, sans-serif", color: "#1d1f24" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>DM queue</h1>
      <p style={{ color: "#5b5f6b", marginTop: 0 }}>
        {due.length} to send now · {later.n} coming up · <a href="/dashboard">dashboard</a>
      </p>
      {due.length === 0 && <p>Nothing due. New messages appear here when they are due.</p>}
      {due.map((t) => (
        <div key={t.id} style={{ border: "1px solid #e3e5ea", borderRadius: 10, padding: 14, margin: "12px 0" }}>
          <div style={{ fontWeight: 600 }}>
            {t.title} <span style={{ color: "#5b5f6b", fontWeight: 400 }}>· {t.channel}{t.subscribers ? ` · ${t.subscribers.toLocaleString()} subs` : ""}</span>
          </div>
          {t.latest && <div style={{ color: "#5b5f6b", fontSize: 13, margin: "4px 0" }}>Latest video: {t.latest}</div>}
          <div style={{ whiteSpace: "pre-wrap", background: "#f6f7f9", padding: 10, borderRadius: 8, margin: "8px 0", fontSize: 15 }}>{t.message}</div>
          <div style={{ fontSize: 13, color: "#5b5f6b", marginBottom: 8 }}>
            {t.channel === "phone" ? t.target : <a href={t.target} target="_blank" rel="noreferrer">{t.target}</a>}
            {t.youtube && (
              <>
                {" · "}
                <a href={t.youtube} target="_blank" rel="noreferrer">
                  channel
                </a>
              </>
            )}
          </div>
          <CopyOpen message={t.message} href={messageLink(t.channel, t.target)} label={OPEN[t.channel] ?? "Copy & open"} />
          <form action={queueAction} style={{ marginTop: 10 }}>
            <input type="hidden" name="id" value={t.id} />
            <button name="a" value="done" style={{ ...btn, fontWeight: 600 }}>Sent ✓</button>
            <button name="a" value="replied" style={btn}>They replied</button>
            <button name="a" value="skip" style={btn}>Skip</button>
          </form>
        </div>
      ))}
    </main>
  );
}
