import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, agencyResearch, contacts, messages, samples } from "@/db/schema";
import { env } from "@/env";
import { draftProblems, pickSampleTarget } from "./draft-rules";
import { askJson } from "./openrouter";
import { makeSample, PlatformError, type Sample } from "./platform";
import type { Facts } from "./research";

/**
 * Draft the first email to one contact, and keep it unsent.
 *
 * Asks the platform for a sample audit in the agency's own brand (of its own
 * listing or a named client's), has the contact's writer model write the
 * email around it, then checks the draft: rules first, then the analysis model
 * against the research and the audit, so nothing is claimed that we do not
 * know. One rewrite is allowed with the checker's notes. The message is stored
 * either way; the agency moves to "queued" only when the draft passed.
 */

const WRITER = `You write the first cold email from GBP Autopilot to a marketing agency. GBP Autopilot is a white-label platform agencies resell to local businesses: it scores and improves each client's Google Business Profile, answers reviews, posts weekly and reports, all under the agency's own brand, from £149 a month. The agency can run three free audits for its own clients once it claims its account.

What we offer them, which the reader must understand by the end of the email: a white-label service for auditing and optimising local businesses' Google Business Profiles, which the agency sells to its own local clients under its own brand. We do the work; the agency's name is on it and it keeps the client relationship. We already ran one audit for them, in their brand, as a demonstration of what their clients would get.

Return ONLY a JSON object: {"subject": string, "body": string}.
- subject: under 50 characters, lower-key, no exclamation marks, no capitals for emphasis. It should hint at the white-label offer or the audit, not be a vague teaser.
- body: plain text, UK English, 70-120 words, short paragraphs. Greet by first name if given, else "Hi there".
- Open with one specific, true thing about their agency from the research, as the reason this offer suits them.
- Then say plainly, in one or two sentences, what we offer: white-label Google Business Profile auditing and optimisation for their local business clients, under their brand, that they can resell. Use the words "white-label" and "Google Business Profile" (or "Google listing").
- Then the sample audit as proof: whose listing it is, one or two concrete findings from it, and the link, written out exactly once on its own line. Say it is already in their brand.
- One soft question at the end, about whether they would offer this to their clients.
- No sign-off or name (the signature is added later), no other links, no prices unless it fits naturally, no placeholders, no flattery, no hype words (revolutionary, game-changer, skyrocket).
- Use only facts given below. Never invent clients, numbers, or results.`;

const CHECKER = `You check a cold email before it is sent. Compare it with the research and the audit it was written from.
Return ONLY a JSON object: {"ok": boolean, "notes": string[]}.
ok is false if the email: does not make clear that we offer white-label Google Business Profile auditing and optimisation the agency can resell to its local clients under its own brand; states anything not supported by the research or the audit (names, numbers, findings, services); misreads the audit; is pushy, flattering or hype-y; reads as a template; or would embarrass the sender if the agency checked it. notes: short, specific fixes (empty when ok).`;

type Draft = { subject: string; body: string };

export type DraftOutcome =
  | { ok: true; passed: boolean; notes: string[]; writer: string; sampleKind: string; costUsd: number }
  | { ok: false; why: string };

export function writerFor(contactId: string): string {
  const models = env.WRITER_MODELS.split(",").map((m) => m.trim()).filter(Boolean);
  // Stable per contact without a lookup: the same contact always gets the same writer.
  const n = parseInt(contactId.replace(/-/g, "").slice(-6), 16);
  return models[n % models.length];
}

export async function draftFirstEmail(contactId: string): Promise<DraftOutcome> {
  const [row] = await db()
    .select({ contact: contacts, agency: agencies })
    .from(contacts)
    .innerJoin(agencies, eq(agencies.id, contacts.agencyId))
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!row) return { ok: false, why: "no such contact" };
  const { contact, agency } = row;

  const [research] = await db()
    .select()
    .from(agencyResearch)
    .where(eq(agencyResearch.agencyId, agency.id))
    .orderBy(desc(agencyResearch.version))
    .limit(1);
  if (!research) return { ok: false, why: "not researched" };
  const facts = research.facts as unknown as Facts;

  const target = pickSampleTarget(agency.name, facts);
  if (!target) {
    await setStatus(agency.id, "no_sample");
    return { ok: false, why: "nothing to audit" };
  }

  let sample: Sample;
  try {
    sample = await makeSample({
      name: target.name,
      town: target.town,
      brand: { name: agency.name, logoUrl: agency.branding?.logoUrl, colour: agency.branding?.colour },
      externalRef: contact.id,
      contact: { email: contact.email, fullName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined },
    });
  } catch (e) {
    // A 4xx about the business (not found on Maps) is the agency's: set it aside.
    // Anything else is the platform's (off, down, key refused): leave it to retry.
    const status = e instanceof PlatformError ? e.status : 0;
    if (status >= 400 && status < 500 && ![401, 403, 429].includes(status)) await setStatus(agency.id, "no_sample");
    return { ok: false, why: `sample: ${e instanceof Error ? e.message : e}` };
  }
  await db()
    .insert(samples)
    .values({
      agencyId: agency.id,
      contactId: contact.id,
      kind: target.kind,
      platformToken: sample.token,
      previewUrl: sample.previewUrl,
      claimUrl: sample.claimUrl,
      score: sample.result.score,
      result: sample.result as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing();

  // A contact keeps its writer for the whole conversation; one dropped from
  // WRITER_MODELS before anything was pushed is replaced (drafts reach here unpushed).
  const kept = contact.writerModel && env.WRITER_MODELS.split(",").map((m) => m.trim()).includes(contact.writerModel);
  const writer = kept ? contact.writerModel! : writerFor(contact.id);
  if (writer !== contact.writerModel) {
    await db().update(contacts).set({ writerModel: writer, updatedAt: new Date() }).where(eq(contacts.id, contact.id));
  }

  const brief = [
    `First name: ${contact.firstName?.trim() || "(unknown)"}`,
    `Agency: ${agency.name} (${agency.website ?? agency.domain})`,
    `Research: ${research.summary ?? ""}`,
    `Services: ${(facts.services ?? []).join(", ") || "-"}; niches: ${(facts.niches ?? []).join(", ") || "-"}; location: ${facts.location ?? "-"}`,
    `Uses GoHighLevel: ${facts.uses_gohighlevel ? "yes" : "no"}; resells white-label: ${facts.resells_white_label ? "yes" : "no"}`,
    ``,
    `The audit (of ${target.kind === "own" ? "the agency's own listing" : "their client"} "${sample.result.title}", ${sample.result.address}):`,
    `Score ${sample.result.score}/100. Verdict: ${sample.result.verdict}`,
    ...sample.result.gaps.slice(0, 4).map((g) => `- ${g.label}: ${g.note}`),
    sample.result.standing ? `Standing: ${sample.result.standing}` : "",
    sample.result.rivalNote ? `Rivals: ${sample.result.rivalNote}` : "",
    sample.result.opportunity ? `Opportunity: ${sample.result.opportunity}` : "",
    `Link to the audit: ${sample.previewUrl}`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  let cost = 0;
  let draft: Draft | null = null;
  let notes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const fix: string = attempt > 0 ? `\n\nYour previous draft:\n${JSON.stringify(draft)}\nFix these problems:\n- ${notes.join("\n- ")}` : "";
    const written = await askJson<Draft>({ model: writer, system: WRITER, user: brief + fix, maxTokens: 800 });
    cost += written.usage.costUsd ?? 0;
    draft = { subject: String(written.data.subject ?? "").trim(), body: String(written.data.body ?? "").trim() };

    notes = draftProblems(draft, sample.previewUrl);
    if (notes.length === 0) {
      const checked = await askJson<{ ok: boolean; notes: string[] }>({
        model: env.ANALYSIS_MODEL,
        system: CHECKER,
        user: `${brief}\n\nThe email:\nSubject: ${draft.subject}\n\n${draft.body}`,
        maxTokens: 600,
      });
      cost += checked.usage.costUsd ?? 0;
      notes = checked.data.ok ? [] : (checked.data.notes ?? ["checker said no, without notes"]);
    }
    if (notes.length === 0) break;
  }

  const passed = notes.length === 0;
  // A re-draft replaces the earlier one, never one Instantly already has.
  await db()
    .delete(messages)
    .where(and(eq(messages.contactId, contact.id), eq(messages.step, 1), isNull(messages.pushedAt)));
  await db().insert(messages).values({
    contactId: contact.id,
    writerModel: writer,
    step: 1,
    subject: draft!.subject,
    body: draft!.body,
    guardrail: { ok: passed, notes },
  });
  await setStatus(agency.id, passed ? "queued" : "needs_review");
  return { ok: true, passed, notes, writer, sampleKind: target.kind, costUsd: cost };
}

async function setStatus(agencyId: string, status: string) {
  await db().update(agencies).set({ status, updatedAt: new Date() }).where(eq(agencies.id, agencyId));
}
