/**
 * Write the unsent drafts to drafts/review.md (git-ignored) for reading.
 * The file holds first names and email bodies, so it stays on this machine.
 *   npm run drafts:review
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";

async function main() {
  const rows = (await db().execute(sql`
    select a.name agency, a.status, a.fit_score, m.writer_model, m.subject, m.body, m.guardrail,
           s.kind sample_kind, s.score sample_score, m.created_at
    from messages m
    join contacts c on c.id = m.contact_id
    join agencies a on a.id = c.agency_id
    left join lateral (select kind, score from samples where contact_id = c.id order by created_at desc limit 1) s on true
    where m.sent_at is null
    order by m.created_at desc`)) as unknown as {
    agency: string;
    status: string;
    fit_score: number | null;
    writer_model: string;
    subject: string | null;
    body: string;
    guardrail: { ok: boolean; notes: string[] } | null;
    sample_kind: string | null;
    sample_score: number | null;
  }[];

  const out = rows.map((r) =>
    [
      `## ${r.agency}`,
      `${r.status} · fit ${r.fit_score ?? "-"} · ${r.writer_model} · sample: ${r.sample_kind ?? "-"} (${r.sample_score ?? "-"}/100)` +
        (r.guardrail?.ok === false ? `\n\n> Checker: ${r.guardrail.notes.join("; ")}` : ""),
      `**${r.subject ?? "(no subject)"}**`,
      r.body,
    ].join("\n\n"),
  );
  mkdirSync("drafts", { recursive: true });
  writeFileSync("drafts/review.md", `# Unsent drafts (${rows.length})\n\n${out.join("\n\n---\n\n")}\n`);
  console.log(`${rows.length} drafts written to drafts/review.md`);
  process.exit(0);
}
main();
