import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { pausedState } from "@/lib/control";
import { waitingDrafts } from "@/lib/pipeline";
import { dayNumbers, recentProblems } from "@/lib/summary";
import { dashboardAction, isOwner, logIn } from "../actions";

export const dynamic = "force-dynamic";

const box = { maxWidth: 900, margin: "40px auto", padding: "0 16px", fontFamily: "Arial, sans-serif", color: "#1d1f24" };
const card = { border: "1px solid #e3e5ea", borderRadius: 8, padding: 16, margin: "16px 0" };
const btn = { padding: "6px 12px", cursor: "pointer", fontSize: 14 };

/** The owner's view: is it running, what happened, what goes next — and the stop buttons. */
export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await isOwner())) {
    const p = await searchParams;
    return (
      <main style={{ ...box, maxWidth: 380 }}>
        <h1 style={{ fontSize: 22 }}>GBP Autopilot outreach</h1>
        <form action={logIn}>
          <input type="password" name="password" placeholder="Password" style={{ padding: 8, width: "100%", marginBottom: 8 }} />
          <button style={btn}>Log in</button>
        </form>
        {p.wrong && <p style={{ color: "#b42318" }}>Wrong password.</p>}
      </main>
    );
  }

  const [paused, n, next, problems] = await Promise.all([pausedState(), dayNumbers(), waitingDrafts(), recentProblems()]);
  const replies = (await db().execute(sql`
    select r.received_at, r.classification, r.body, a.name agency
    from replies r join contacts c on c.id = r.contact_id join agencies a on a.id = c.agency_id
    order by r.received_at desc limit 20`)) as unknown as { received_at: string; classification: string | null; body: string; agency: string }[];
  const runs = (await db().execute(sql`
    select at, payload->'lines' lines from events where source = 'bot' and type = 'run' order by at desc limit 6`)) as unknown as { at: string; lines: string[] | null }[];
  const when = (d: string | null) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" }) : "—");

  return (
    <main style={box}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>GBP Autopilot outreach</h1>
      <p style={{ marginTop: 0 }}>
        <a href="/queue">DM queue{n.dms_due ? ` (${n.dms_due} due)` : ""}</a>
      </p>

      <div style={{ ...card, background: paused.paused ? "#fff4e5" : "#eefaf1" }}>
        <form action={dashboardAction} style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 18 }}>
            {paused.paused ? `⏸ Paused — ${paused.reason ?? ""} (${when(paused.at ?? null)})` : "▶ Running"}
          </span>
          <input type="hidden" name="a" value={paused.paused ? "resume" : "pause"} />
          <button style={{ ...btn, fontWeight: 600 }}>{paused.paused ? "Resume sending" : "Pause everything"}</button>
        </form>
      </div>

      <div style={{ ...card, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {[
          ["Sent (24h)", n.sent],
          ["Replies (24h)", n.replies],
          ["Interested (24h)", n.interested],
          ["Bounces (24h)", n.bounced],
          ["Audits viewed (24h)", n.viewed],
          ["Sign-ups (24h)", n.signups],
          ["In campaign", n.total_pushed],
          ["Sent, all time", n.total_sent],
          ["Replies, all time", n.total_replies],
          ["Signed up", n.total_signups],
          ["To research", n.to_research],
          ["Failed the check", n.needs_review],
          ["YouTube channels found", n.yt_found],
          ["Creators (free white-label, 40%)", n.yt_partners],
          ["DMs / calls due", n.dms_due],
        ].map(([label, v]) => (
          <div key={label as string}>
            <div style={{ color: "#5b5f6b", fontSize: 13 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>

      {problems.length > 0 && (
        <div style={{ ...card, borderColor: "#f3c4bf" }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Problems (24h)</h2>
          <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Waiting to go out ({next.length})</h2>
        <p style={{ color: "#5b5f6b", marginTop: 0 }}>Added to the campaign when the hold ends, unless you stop them.</p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <tbody>
            {next.slice(0, 100).map((d) => (
              <tr key={d.id} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: 6 }}>{d.agency}</td>
                <td style={{ padding: 6, color: "#5b5f6b" }}>{d.subject}</td>
                <td style={{ padding: 6, whiteSpace: "nowrap" }}>{d.hold_until ? `goes ${when(d.hold_until)}` : "due now"}</td>
                <td style={{ padding: 6 }}>
                  <form action={dashboardAction}>
                    <input type="hidden" name="a" value="stop" />
                    <input type="hidden" name="id" value={d.id} />
                    <button style={btn}>Stop</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Latest replies</h2>
        {replies.length === 0 && <p>None yet.</p>}
        {replies.map((r, i) => (
          <div key={i} style={{ borderTop: "1px solid #eee", padding: "8px 0" }}>
            <b>{r.agency}</b> · {r.classification ?? "not sorted yet"} · <span style={{ color: "#5b5f6b" }}>{when(r.received_at)}</span>
            <div style={{ color: "#333", fontSize: 14, whiteSpace: "pre-wrap" }}>{r.body.slice(0, 400)}</div>
          </div>
        ))}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Recent runs</h2>
        {runs.map((r, i) => (
          <div key={i} style={{ fontSize: 13, borderTop: "1px solid #eee", padding: "6px 0" }}>
            <b>{when(r.at)}</b> {(r.lines ?? []).join(" · ") || "nothing to do"}
          </div>
        ))}
      </div>
    </main>
  );
}
