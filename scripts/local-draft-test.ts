/**
 * Try the local model as the writer of first emails, against drafts Kimi
 * already wrote. READ-ONLY on the database: it rebuilds the same brief (the
 * research, the audit, its link) for each Kimi draft, has the local model write
 * the email with the production prompt, and keeps both on this machine.
 *
 * Each local draft goes through the production check: the rules, then Kimi as
 * the checker (a few cents for the lot), one rewrite with its notes. The local
 * model also checks the same draft, to see whether it could be the checker too.
 *
 *   --limit 20       how many Kimi drafts to compare (newest first)
 *   --minutes 600    stop after this long; run again and it carries on
 *   --report         print the comparison so far, and write the side-by-side file
 *
 * Run:  npx dotenv -e .env.local -- npx tsx scripts/local-draft-test.ts --limit 20
 * Out:  %LOCALAPPDATA%\gbp-shadow\draft-test.jsonl, draft-test.txt
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { agencies, agencyResearch, contacts, messages, samples } from "../src/db/schema";
import { env } from "../src/env";
import { CHECKER, firstBrief, WRITER } from "../src/lib/draft";
import { draftProblems } from "../src/lib/draft-rules";
import { askLocalJson, LOCAL_MODEL, startOllama } from "../src/lib/ollama";
import { forMarket, marketOf } from "../src/lib/offer";
import { askJson } from "../src/lib/openrouter";
import type { SampleResult } from "../src/lib/platform";
import type { Facts } from "../src/lib/research";

const DIR = join(process.env.LOCALAPPDATA ?? ".", "gbp-shadow");
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string, d: string) => (flag(n) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const LIMIT = Number(arg("limit", "20"));
const MINUTES = Number(arg("minutes", "600"));
const VERSION = arg("version", "v1");
const OUT = join(DIR, VERSION === "v1" ? "draft-test.jsonl" : `draft-test-${VERSION}.jsonl`);
const TXT = join(DIR, VERSION === "v1" ? "draft-test.txt" : `draft-test-${VERSION}.txt`);

/**
 * v2 (2026-11-25), for the local writer only. v1 passed 5 of 13 (Kimi 11):
 * four drafts came back empty, the rest ran short (67 words), said "Hi there"
 * when the research named the owner, and stretched the audit's findings.
 */
const LOCAL_WRITING = `

Before you write, read these again; they are where drafts fail:
- Length: the body must be 90-120 words. Count them. Under 90 is too short.
- The body must contain the exact word "white-label", and the audit link exactly once, on its own line, character for character as given.
- Greeting: if the research names the person (an owner, a founder) or a first name is given, greet them by first name. "Hi there" only when no name is known anywhere.
- Audit findings: use the audit's own words and numbers, with their limits. If it looked at the five most recent reviews, say "your five most recent reviews", not "your reviews". If it says more people a month, say people, not searches. Never round up or widen a finding.
- What they sell: say only what the research says. If a service is not mentioned, say it does not appear on their site, never that they do not offer it.
- Return the JSON object with exactly two keys, "subject" and "body", both non-empty strings.`;

/** The local model sometimes names the keys differently or nests them: find the draft wherever it put it. */
function pickDraft(data: unknown): { subject: string; body: string } {
  const find = (o: unknown, key: string): string => {
    if (!o || typeof o !== "object") return "";
    for (const [k, v] of Object.entries(o)) {
      if (k.toLowerCase() === key && typeof v === "string") return v.trim();
    }
    for (const v of Object.values(o)) {
      const hit = typeof v === "object" ? find(v, key) : "";
      if (hit) return hit;
    }
    return "";
  };
  // Seen: {"subject": "...", " ": "<the email>"}. Failing a named key, the longest string is the body.
  const longest = () =>
    Object.values((data ?? {}) as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string")
      .sort((a, b) => b.length - a.length)[0]
      ?.trim() ?? "";
  return { subject: find(data, "subject"), body: find(data, "body") || find(data, "email") || longest() };
}

type Draft = { subject: string; body: string };
type Result = {
  messageId: string;
  agency: string;
  kimi: Draft & { passed: boolean };
  local: Draft & { attempts: number; passed: boolean; notes: string[]; firstTryPassed: boolean };
  localChecker: { onLocal: boolean; onKimi: boolean };
  secs: number;
  costUsd: number;
};
const readLines = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function report() {
  const rows = readLines<Result>(OUT);
  if (!rows.length) return console.log("No results yet.");
  const n = rows.length;
  const c = (f: (r: Result) => boolean) => rows.filter(f).length;
  console.log(`${n} first emails, Kimi's draft vs the local model's (${LOCAL_MODEL})\n`);
  console.log(`Passed the check (rules + Kimi checker, one rewrite):  Kimi ${c((r) => r.kimi.passed)}/${n}   local ${c((r) => r.local.passed)}/${n}`);
  console.log(`Local passed first time, no rewrite:                   ${c((r) => r.local.firstTryPassed)}/${n}`);
  console.log(`Average words:                                          Kimi ${(rows.reduce((a, r) => a + words(r.kimi.body), 0) / n).toFixed(0)}   local ${(rows.reduce((a, r) => a + words(r.local.body), 0) / n).toFixed(0)}`);
  console.log(`Local as checker agrees with Kimi's checker on local drafts: ${c((r) => r.localChecker.onLocal === r.local.passed)}/${n}; passes Kimi's own drafts: ${c((r) => r.localChecker.onKimi)}/${n}`);
  console.log(`Median local time ${[...rows.map((r) => r.secs)].sort((a, b) => a - b)[Math.floor(n / 2)].toFixed(0)}s; Kimi checker cost $${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(3)}`);
  const why = rows.filter((r) => !r.local.passed).flatMap((r) => r.local.notes);
  if (why.length) console.log(`\nWhy local drafts failed:\n${why.map((w) => `  - ${w}`).join("\n")}`);
  writeFileSync(
    TXT,
    rows
      .map(
        (r) =>
          `==== ${r.agency}\n\n--- Kimi (${r.kimi.passed ? "passed" : "failed"})\nSubject: ${r.kimi.subject}\n\n${r.kimi.body}\n\n--- Local (${r.local.passed ? "passed" : "failed"}${r.local.attempts > 1 ? ", after a rewrite" : ""})\nSubject: ${r.local.subject}\n\n${r.local.body}\n${r.local.notes.length ? `\nChecker: ${r.local.notes.join("; ")}\n` : ""}`,
      )
      .join("\n\n"),
  );
  console.log(`\nSide by side: ${TXT}`);
}

async function check(system: string, user: string, local: boolean): Promise<{ ok: boolean; notes: string[]; cost: number }> {
  if (local) {
    const { data } = await askLocalJson<{ ok: boolean; notes: string[] }>(system, user);
    return { ok: Boolean(data.ok), notes: data.notes ?? [], cost: 0 };
  }
  // Kimi says 429 "overloaded" now and then: wait and ask again rather than lose the run.
  let r: Awaited<ReturnType<typeof askJson<{ ok: boolean; notes: string[] }>>> | null = null;
  for (let attempt = 1; !r; attempt++) {
    try {
      r = await askJson<{ ok: boolean; notes: string[] }>({ model: env.ANALYSIS_MODEL, system, user, maxTokens: 600 });
    } catch (e) {
      if (attempt >= 5 || !/429|overloaded|5\d\d/.test(String(e))) throw e;
      await new Promise((res) => setTimeout(res, attempt * 30_000));
    }
  }
  return { ok: Boolean(r.data.ok), notes: r.data.ok ? [] : (r.data.notes ?? ["checker said no, without notes"]), cost: r.usage.costUsd ?? 0 };
}

async function main() {
  if (flag("report")) {
    report();
    process.exit(0);
  }
  const done = new Set(readLines<Result>(OUT).map((r) => r.messageId));
  // A later version re-runs exactly the emails v1 compared, so the two read side by side.
  const same = VERSION === "v1" ? null : new Set(readLines<Result>(join(DIR, "draft-test.jsonl")).map((r) => r.messageId));
  const kimiDrafts = await db()
    .select({ m: messages, contact: contacts, agency: agencies })
    .from(messages)
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .innerJoin(agencies, eq(agencies.id, contacts.agencyId))
    // Only drafts whose audit is still on file: the brief cannot be rebuilt without it.
    // Agency emails only (creators are written by another prompt), whose audit is still on file.
    .where(
      and(
        eq(messages.step, 1),
        sql`${contacts.source} not like 'partner:%'`,
        sql`exists (select 1 from samples s where s.contact_id = ${messages.contactId})`,
        sql`exists (select 1 from agency_research r where r.agency_id = ${agencies.id})`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(same ? 2000 : LIMIT * 3);
  const todo = same
    ? kimiDrafts.filter((d) => same.has(d.m.id) && !done.has(d.m.id))
    : kimiDrafts.filter((d) => d.m.writerModel.includes("kimi") && !done.has(d.m.id)).slice(0, Math.max(0, LIMIT - done.size));
  console.log(`${done.size} done, ${todo.length} to go.`);
  if (!todo.length) return report(), process.exit(0);
  if (!(await startOllama())) throw new Error("Ollama would not start");

  const until = Date.now() + MINUTES * 60_000;
  for (const { m, contact, agency } of todo) {
    if (Date.now() > until) break;
    const [research] = await db().select().from(agencyResearch).where(eq(agencyResearch.agencyId, agency.id)).orderBy(desc(agencyResearch.version)).limit(1);
    const [sample] = await db().select().from(samples).where(eq(samples.contactId, contact.id)).orderBy(desc(samples.createdAt)).limit(1);
    if (!research || !sample) {
      console.log(`${agency.name}: skipped (${research ? "" : "no research "}${sample ? "" : "no audit"})`);
      continue;
    }
    const input = { contact, agency, research, facts: research.facts as unknown as Facts, kind: sample.kind, result: sample.result as unknown as SampleResult, previewUrl: sample.previewUrl };
    const brief = await firstBrief(input);
    const market = marketOf(agency.country);
    const t0 = Date.now();

    // The production loop (draft.ts writeFirst), with the local model as the writer.
    let draft: Draft = { subject: "", body: "" };
    let notes: string[] = [];
    let attempts = 0;
    let firstTryPassed = false;
    let cost = 0;
    const system = forMarket(WRITER, market) + (VERSION === "v1" ? "" : LOCAL_WRITING);
    for (let attempt = 0; attempt < 2; attempt++) {
      // v2: the rules cost nothing to check, so the local model fixes what they find
      // (up to three goes) before Kimi is asked at all.
      for (let go = 0; go < (VERSION === "v1" ? 1 : 3); go++) {
        attempts++;
        const fix = attempts > 1 ? `\n\nYour previous draft:\n${JSON.stringify(draft)}\nFix these problems:\n- ${notes.join("\n- ")}` : "";
        const { data } = await askLocalJson<Draft>(system, brief + fix);
        draft = VERSION === "v1" ? { subject: String(data.subject ?? "").trim(), body: String(data.body ?? "").trim() } : pickDraft(data);
        if (!draft.body) console.log(`  empty body; keys were ${JSON.stringify(Object.keys(data ?? {}))}`);
        notes = draftProblems(draft, sample.previewUrl);
        if (!notes.length) break;
      }
      if (!notes.length) {
        const c = await check(forMarket(CHECKER, market), `${brief}\n\nThe email:\nSubject: ${draft.subject}\n\n${draft.body}`, false);
        cost += c.cost;
        notes = c.ok ? [] : c.notes;
      }
      if (attempt === 0) firstTryPassed = notes.length === 0;
      if (!notes.length) break;
    }
    const secs = (Date.now() - t0) / 1000;
    const asLocal = (d: Draft) => check(forMarket(CHECKER, market), `${brief}\n\nThe email:\nSubject: ${d.subject}\n\n${d.body}`, true).then((c) => c.ok && draftProblems(d, sample.previewUrl).length === 0);
    const out: Result = {
      messageId: m.id,
      agency: agency.name,
      kimi: { subject: m.subject ?? "", body: m.body ?? "", passed: Boolean((m.guardrail as { ok?: boolean } | null)?.ok) },
      local: { ...draft, attempts, passed: notes.length === 0, notes, firstTryPassed },
      // v1 showed the local model cannot be the checker (it failed all 13 of Kimi's drafts); not asked again.
      localChecker: VERSION === "v1" ? { onLocal: await asLocal(draft), onKimi: await asLocal({ subject: m.subject ?? "", body: m.body ?? "" }) } : { onLocal: false, onKimi: false },
      secs,
      costUsd: cost,
    };
    appendFileSync(OUT, JSON.stringify(out) + "\n");
    console.log(`${agency.name}: kimi ${out.kimi.passed ? "pass" : "fail"} | local ${out.local.passed ? "pass" : "fail"}${attempts > 1 ? " (rewrite)" : ""} ${words(draft.body)}w (${secs.toFixed(0)}s)`);
  }
  report();
  process.exit(0);
}

main();
