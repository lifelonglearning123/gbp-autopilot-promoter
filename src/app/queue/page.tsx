import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { messageLink } from "@/lib/creator-rules";
import { DMS_PER_DAY } from "@/lib/creators";
import { isOwner, queueAction } from "../actions";
import { CopyOpen } from "./copy-open";

export const dynamic = "force-dynamic";

const OPEN: Record<string, string> = { instagram: "Copy & open Instagram", tiktok: "Copy & open TikTok", skool: "Copy & open Skool", phone: "Copy script & call", youtube: "Open YouTube" };

type Task = {
  id: string;
  channel: "instagram" | "tiktok" | "skool" | "phone" | "youtube";
  target: string;
  message: string;
  due_at: string;
  title: string;
  subscribers: number | null;
  youtube: string | null;
  latest: string | null;
};

type Sent = { title: string; channel: string; target: string; done_at: string; replied_at: string | null; skipped: boolean };

/**
 * The DM queue: messages a person sends by hand (Instagram, TikTok, Skool,
 * calls). Built for a phone. Three views:
 *   to send      everything due, oldest first
 *   one at a time  one card, a counter, and Sent moves on to the next
 *   sent         what has gone, when, and who replied
 */
export default async function Queue({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await isOwner())) {
    return (
      <main style={{ maxWidth: 380, margin: "60px auto", padding: "0 16px", fontFamily: "Arial, sans-serif" }}>
        <p>
          Log in on the <a href="/dashboard">dashboard</a> first.
        </p>
      </main>
    );
  }
  const view = (await searchParams).view ?? "send";
  const one = view === "one";

  const due = (await db().execute(sql`
    select t.id, t.channel, t.target, t.message, t.due_at, cr.title, cr.subscribers, cr.links->>'youtube' youtube,
           cr.recent_videos->0->>'title' latest
    from outreach_tasks t join creators cr on cr.id = t.creator_id
    where t.done_at is null and t.skipped_at is null and t.replied_at is null and t.due_at <= now()
    order by t.due_at limit ${one ? 1 : 50}`)) as unknown as Task[];
  const [n] = (await db().execute(sql`
    select count(*) filter (where done_at is null and skipped_at is null and replied_at is null and due_at <= now())::int due,
           count(*) filter (where done_at is null and skipped_at is null and replied_at is null and due_at > now())::int later,
           count(*) filter (where done_at >= date_trunc('day', now()) and replied_at is null)::int sent_today,
           count(*) filter (where done_at is not null and replied_at is null)::int sent_all,
           count(*) filter (where replied_at is not null)::int replied
    from outreach_tasks`)) as unknown as { due: number; later: number; sent_today: number; sent_all: number; replied: number }[];
  const sent =
    view === "sent"
      ? ((await db().execute(sql`
          select cr.title, t.channel, t.target, coalesce(t.done_at, t.skipped_at) done_at, t.replied_at, t.skipped_at is not null skipped
          from outreach_tasks t join creators cr on cr.id = t.creator_id
          where t.done_at is not null or t.skipped_at is not null
          order by coalesce(t.done_at, t.skipped_at) desc limit 200`)) as unknown as Sent[])
      : [];

  const btn = { padding: "8px 12px", fontSize: 14, cursor: "pointer", marginRight: 6 };
  const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" });
  const tab = (v: string, label: string) =>
    view === v ? <b style={{ marginRight: 14 }}>{label}</b> : <a href={`/queue?view=${v}`} style={{ marginRight: 14 }}>{label}</a>;

  return (
    <main style={{ maxWidth: 560, margin: "24px auto", padding: "0 12px", fontFamily: "Arial, sans-serif", color: "#1d1f24" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>DM queue</h1>
      <p style={{ color: "#5b5f6b", marginTop: 0 }}>
        {n.due} to send now · {n.later} coming up · <b>{n.sent_today} sent today</b> (aim for about {DMS_PER_DAY}; Instagram allows 20–30 cold DMs a day) ·{" "}
        <a href="/dashboard">dashboard</a>
      </p>
      <p style={{ margin: "8px 0 4px" }}>
        {tab("send", "To send")}
        {tab("one", "One at a time")}
        {tab("sent", `Sent (${n.sent_all}) · replied (${n.replied})`)}
      </p>

      {view !== "sent" && due.length === 0 && <p>Nothing due. New messages appear here when they are due.</p>}
      {view !== "sent" &&
        due.map((t) => (
          <div key={t.id} style={{ border: "1px solid #e3e5ea", borderRadius: 10, padding: 14, margin: "12px 0" }}>
            {one && <div style={{ color: "#5b5f6b", fontSize: 13, marginBottom: 6 }}>1 of {n.due} due · {n.sent_today} sent today</div>}
            <div style={{ fontWeight: 600 }}>
              {t.title}{" "}
              <span style={{ color: "#5b5f6b", fontWeight: 400 }}>
                · {t.channel}
                {t.subscribers ? ` · ${t.subscribers.toLocaleString()} subs` : ""}
              </span>
            </div>
            {t.latest && <div style={{ color: "#5b5f6b", fontSize: 13, margin: "4px 0" }}>Latest video: {t.latest}</div>}
            <div style={{ whiteSpace: "pre-wrap", background: "#f6f7f9", padding: 10, borderRadius: 8, margin: "8px 0", fontSize: 15 }}>{t.message}</div>
            <div style={{ fontSize: 13, color: "#5b5f6b", marginBottom: 8 }}>
              {t.channel === "phone" ? (
                t.target
              ) : (
                <a href={t.target} target="_blank" rel="noreferrer">
                  {t.target}
                </a>
              )}
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
              <button name="a" value="done" style={{ ...btn, fontWeight: 600 }}>
                {one ? "Sent ✓ — next" : "Sent ✓"}
              </button>
              <button name="a" value="replied" style={btn}>
                They replied
              </button>
              <button name="a" value="skip" style={btn}>
                Skip
              </button>
            </form>
          </div>
        ))}

      {view === "sent" && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, marginTop: 8 }}>
          <tbody>
            {sent.length === 0 && (
              <tr>
                <td>Nothing sent yet.</td>
              </tr>
            )}
            {sent.map((s, i) => (
              <tr key={i} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: 6 }}>
                  {s.title}
                  <div style={{ color: "#5b5f6b", fontSize: 12 }}>
                    {s.channel === "phone" ? (
                      s.target
                    ) : (
                      <a href={s.target} target="_blank" rel="noreferrer">
                        {s.channel}
                      </a>
                    )}
                  </div>
                </td>
                <td style={{ padding: 6, whiteSpace: "nowrap", color: "#5b5f6b" }}>{when(s.done_at)}</td>
                <td style={{ padding: 6, whiteSpace: "nowrap" }}>{s.skipped ? "skipped" : s.replied_at ? <b>replied</b> : "sent"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
