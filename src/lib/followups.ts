import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, agencyResearch, contacts, messages, samples } from "@/db/schema";
import { env } from "@/env";
import { followUpProblems, templateFollowUps, type FollowUps } from "./draft-rules";
import { askJson } from "./openrouter";
import { OFFER_FACTS } from "./offer";
import type { SampleResult } from "./platform";
import type { Facts } from "./research";

/**
 * Steps 2-4 for one contact, written from the same research and audit as the
 * first email, which the writer also sees so nothing is repeated:
 *   2 (day 3)  a short nudge with one new finding from the audit
 *   3 (day 7)  how it works for them, price, three free audits, the claim link
 *   4 (day 14) a short last note
 * Checked like the first email (rules, then the analysis model), one rewrite;
 * if they still fail, safe template follow-ups built from facts alone are kept,
 * so no lead ever reaches a step with an empty email. Stored as messages
 * steps 2-4.
 */

const WRITER = `You write three short follow-up emails from GBP Autopilot to a marketing agency that got our first email (shown below) and has not replied. They are sent as replies in the same thread, so no subject lines.
${OFFER_FACTS}

Return ONLY a JSON object: {"body_2": string, "body_3": string, "body_4": string}.
- body_2 (sent day 3): 35-70 words. Greet by first name (else "Hi there"). One NEW concrete finding from the audit that the first email did not mention, why it matters to the business, and the audit link once. End with a short question.
- body_3 (sent day 7): 60-110 words. How it works for the agency: they sell it under their brand, we do the work, they keep the client; it works inside the GoHighLevel they already use (each audit lands in their GHL sub-account with the findings and the tasks); from £149 a month; three free audits once they claim their account; the CLAIM LINK written out once on its own line (if no claim link is given, the audit link). End with a soft question.
- body_4 (sent day 14): 25-55 words. A short, friendly last note: you'll stop writing; they can reply any time. No link needed.
- Plain text, UK English, short paragraphs. No sign-off or name (added later). No "just following up", "bumping this", "circling back", no guilt, no hype, no flattery, no placeholders.
- Use only the facts given. Never invent clients, numbers or results.`;

const CHECKER = `You check three follow-up emails before they are sent, against the research, the audit and the first email they follow.
True facts about our offer, which the emails may state:
${OFFER_FACTS}
Return ONLY a JSON object: {"ok": boolean, "notes": string[]}.
ok is false if any email states something not supported by the research or the audit, misreads the audit, repeats the first email instead of adding something new, is pushy, guilt-tripping, flattering or hype-y, or would embarrass the sender. notes: short, specific fixes (empty when ok).`;

export type FollowUpOutcome = { ok: true; template: boolean; notes: string[] } | { ok: false; why: string };

export async function draftFollowUps(contactId: string): Promise<FollowUpOutcome> {
  const [row] = await db()
    .select({ contact: contacts, agency: agencies })
    .from(contacts)
    .innerJoin(agencies, eq(agencies.id, contacts.agencyId))
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!row) return { ok: false, why: "no such contact" };
  const { contact, agency } = row;

  const [first] = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.contactId, contactId), eq(messages.step, 1)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!first) return { ok: false, why: "no first email" };
  const [sample] = await db().select().from(samples).where(eq(samples.contactId, contactId)).orderBy(desc(samples.createdAt)).limit(1);
  if (!sample) return { ok: false, why: "no sample audit" };
  const [research] = await db()
    .select()
    .from(agencyResearch)
    .where(eq(agencyResearch.agencyId, agency.id))
    .orderBy(desc(agencyResearch.version))
    .limit(1);
  const facts = (research?.facts ?? {}) as unknown as Partial<Facts>;
  const result = sample.result as unknown as SampleResult;

  const brief = [
    `First name: ${contact.firstName?.trim() || "(unknown)"}`,
    `Agency: ${agency.name} (${agency.website ?? agency.domain})`,
    `Research: ${research?.summary ?? ""}`,
    `Services: ${(facts.services ?? []).join(", ") || "-"}; niches: ${(facts.niches ?? []).join(", ") || "-"}`,
    ``,
    `The audit ("${result.title}", ${result.address}): score ${result.score}/100. Verdict: ${result.verdict}`,
    ...(result.gaps ?? []).slice(0, 6).map((g) => `- ${g.label}: ${g.note}`),
    result.standing ? `Standing: ${result.standing}` : "",
    result.rivalNote ? `Rivals: ${result.rivalNote}` : "",
    result.opportunity ? `Opportunity: ${result.opportunity}` : "",
    `Audit link: ${sample.previewUrl}`,
    `Claim link: ${sample.claimUrl ?? "(none)"}`,
    ``,
    `The first email (already sent):\nSubject: ${first.subject}\n\n${first.body}`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  let draft: FollowUps | null = null;
  let notes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const fix: string = attempt > 0 ? `\n\nYour previous drafts:\n${JSON.stringify(draft)}\nFix these problems:\n- ${notes.join("\n- ")}` : "";
    const written = await askJson<FollowUps>({ model: contact.writerModel ?? env.WRITER_MODELS.split(",")[0].trim(), system: WRITER, user: brief + fix, maxTokens: 1200 });
    draft = {
      body_2: String(written.data.body_2 ?? "").trim(),
      body_3: String(written.data.body_3 ?? "").trim(),
      body_4: String(written.data.body_4 ?? "").trim(),
    };
    notes = followUpProblems(draft, sample.previewUrl, sample.claimUrl);
    if (notes.length === 0) {
      const checked = await askJson<{ ok: boolean; notes: string[] }>({
        model: env.ANALYSIS_MODEL,
        system: CHECKER,
        user: `${brief}\n\nThe follow-ups:\n${JSON.stringify(draft, null, 1)}`,
        maxTokens: 600,
      });
      notes = checked.data.ok ? [] : (checked.data.notes ?? ["checker said no, without notes"]);
    }
    if (notes.length === 0) break;
  }

  const template = notes.length > 0;
  const final = template
    ? templateFollowUps({ firstName: contact.firstName, finding: result.gaps?.[1]?.note ?? result.gaps?.[0]?.note ?? null, previewUrl: sample.previewUrl, claimUrl: sample.claimUrl })
    : draft!;

  // Replace earlier unsent follow-ups for this contact.
  await db().delete(messages).where(and(eq(messages.contactId, contactId), gte(messages.step, 2), isNull(messages.sentAt)));
  await db()
    .insert(messages)
    .values(
      ([2, 3, 4] as const).map((step) => ({
        contactId,
        writerModel: template ? "template" : (contact.writerModel ?? "unknown"),
        step,
        subject: null,
        body: final[`body_${step}` as keyof FollowUps],
        guardrail: { ok: true, notes: template ? [`template used; writer's failed: ${notes.join("; ")}`] : [] },
      })),
    );
  return { ok: true, template, notes };
}

/** The follow-ups as Instantly custom variables (HTML), or null if any is missing. */
export async function followUpVars(contactId: string, toHtml: (s: string) => string): Promise<Record<string, string> | null> {
  const rows = await db()
    .select({ step: messages.step, body: messages.body })
    .from(messages)
    .where(and(eq(messages.contactId, contactId), gte(messages.step, 2)));
  const by = new Map(rows.map((r) => [r.step, r.body]));
  if (![2, 3, 4].every((s) => by.get(s)?.trim())) return null;
  return { body_2_html: toHtml(by.get(2)!), body_3_html: toHtml(by.get(3)!), body_4_html: toHtml(by.get(4)!) };
}
