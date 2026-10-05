import { signatureOk } from "@/lib/links";
import { confirmLink } from "../actions";

export const dynamic = "force-dynamic";

const WHAT: Record<string, string> = {
  stop: "Stop this draft? It will never be sent.",
  pause: "Pause everything? The Instantly campaign stops and nothing new is added until you resume.",
  resume: "Resume sending? The campaign restarts and new drafts are added after their hold.",
};
const DONE: Record<string, string> = {
  stop: "Stopped. That draft will not be sent.",
  pause: "Paused. Nothing is being sent.",
  resume: "Resumed. Sending has restarted.",
  bad: "That link is not valid.",
};

/**
 * Where the links in the owner's emails land. Opening the link changes
 * nothing (mail scanners open links on their own); the button does.
 */
export default async function Act({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await searchParams;
  const box = { maxWidth: 520, margin: "64px auto", padding: "0 16px", fontFamily: "Arial, sans-serif" };
  if (p.done) {
    return (
      <main style={box}>
        <h1 style={{ fontSize: 22 }}>{DONE[p.done] ?? "Done."}</h1>
        <p>
          <a href="/dashboard">Open the dashboard</a>
        </p>
      </main>
    );
  }
  const a = p.a ?? "";
  const id = p.id ?? "-";
  if (!signatureOk(a, id, p.s ?? null)) {
    return (
      <main style={box}>
        <h1 style={{ fontSize: 22 }}>{DONE.bad}</h1>
      </main>
    );
  }
  return (
    <main style={box}>
      <h1 style={{ fontSize: 22 }}>{WHAT[a]}</h1>
      <form action={confirmLink}>
        <input type="hidden" name="a" value={a} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="s" value={p.s} />
        <button style={{ fontSize: 16, padding: "10px 18px", cursor: "pointer" }}>Yes, {a}</button>
      </form>
    </main>
  );
}
