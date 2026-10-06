import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, agencyResearch, contacts, messages, samples } from "@/db/schema";
import { env } from "@/env";
import { draftProblems, sameBusiness, sampleTargets, type SampleTarget } from "./draft-rules";
import { creatorContext } from "./creators";
import { askJson } from "./openrouter";
import { OFFER_FACTS, PARTNER_FACTS } from "./offer";
import { makeSample, PlatformError, type Sample, type SampleResult } from "./platform";
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

const WRITER = `You write the first cold email from GBP Autopilot to a marketing agency that runs on GoHighLevel.
${OFFER_FACTS}

What we offer them, which the reader must understand by the end of the email: a white-label service for auditing and optimising local businesses' Google Business Profiles, which the agency sells to its own local clients under its own brand. We do the work; the agency's name is on it and it keeps the client relationship. We already ran one audit for them, in their brand, as a demonstration of what their clients would get.

Return ONLY a JSON object: {"subject": string, "body": string}.
- subject: under 50 characters, lower-key, no exclamation marks, no capitals for emphasis. It should hint at the white-label offer or the audit, not be a vague teaser.
- body: plain text, UK English, 70-120 words, short paragraphs. Greet by first name if given, else "Hi there".
- Open with one specific, true thing about their agency from the research, as the reason this offer suits them. If they run a YouTube channel (given below), open instead with one of their recent videos, by its topic, naturally (not "I watched your video", no flattery).
- Then say plainly, in one or two sentences, what we offer: white-label Google Business Profile auditing and optimisation for their local business clients, under their brand, that they can resell. Use the words "white-label" and "Google Business Profile" (or "Google listing"). Say in a few words that it works with the GoHighLevel they already use (e.g. findings land in their GHL sub-accounts as tasks).
- Then the sample audit as proof: whose listing it is, one or two concrete findings from it, and the link, written out exactly once on its own line. Say it is already in their brand.
- One soft question at the end, about whether they would offer this to their clients.
- Only if they run a YouTube channel (given below): add one last line starting "P.S." saying creators who recommend local.macaws.ai (our £49/month version for single local businesses) to their audience earn 40% of what each referred business pays, for life; they can reply for a referral link. No link in the P.S. Keep the whole email, P.S. included, under 125 words.
- No sign-off or name (the signature is added later), no other links, no prices unless it fits naturally, no placeholders, no flattery, no hype words (revolutionary, game-changer, skyrocket).
- Use only facts given below. Never invent clients, numbers, or results.`;

const CHECKER = `You check a cold email before it is sent. Compare it with the research and the audit it was written from.
True facts about our offer, which the email may state:
${OFFER_FACTS}
${PARTNER_FACTS}
A P.S. about the 40% partner offer is expected when the agency runs a YouTube channel.
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

  // Try each business in turn until Google finds the one we asked for.
  let sample: Sample | null = null;
  let target: SampleTarget | null = null;
  const misses: string[] = [];
  for (const t of sampleTargets(agency.name, facts, agency.country)) {
    try {
      const s = await makeSample({
        name: t.name,
        town: t.town,
        brand: { name: agency.name, logoUrl: agency.branding?.logoUrl, colour: agency.branding?.colour },
        externalRef: contact.id,
        contact: { email: contact.email, fullName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined },
      });
      // Google matched a different business: an email about it would be wrong.
      if (sameBusiness(t.name, s.result.title)) {
        sample = s;
        target = t;
        break;
      }
      misses.push(`found "${s.result.title}", not "${t.name}"`);
    } catch (e) {
      // A 4xx about the business (not found, several match) is the agency's: try the next.
      // Anything else is the platform's (off, down, key refused): stop and leave it to retry.
      const status = e instanceof PlatformError ? e.status : 0;
      if (!(status >= 400 && status < 500 && ![401, 403, 429].includes(status))) {
        return { ok: false, why: `sample: ${e instanceof Error ? e.message : e}` };
      }
      misses.push(`${t.name}${t.town ? `, ${t.town}` : ""}: ${e instanceof Error ? e.message.split(".")[0] : e}`);
    }
  }
  if (!sample || !target) {
    await setStatus(agency.id, "no_sample");
    return { ok: false, why: `no audit: ${misses.join("; ")}` };
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

  const { draft, notes, cost } = await writeFirst({ contact, agency, research, facts, kind: target.kind, result: sample.result, previewUrl: sample.previewUrl, writer });

  const passed = notes.length === 0;
  // A re-draft replaces the earlier one, never one Instantly already has.
  await db()
    .delete(messages)
    .where(and(eq(messages.contactId, contact.id), eq(messages.step, 1), isNull(messages.pushedAt)));
  await db().insert(messages).values({
    contactId: contact.id,
    writerModel: writer,
    step: 1,
    subject: draft.subject,
    body: draft.body,
    guardrail: { ok: passed, notes },
    // The owner's window to stop it before it is pushed.
    holdUntil: new Date(Date.now() + env.HOLD_HOURS * 3_600_000),
  });
  await setStatus(agency.id, passed ? "queued" : "needs_review");
  return { ok: true, passed, notes, writer, sampleKind: target.kind, costUsd: cost };
}

type Contact = typeof contacts.$inferSelect;
type Agency = typeof agencies.$inferSelect;
type Research = typeof agencyResearch.$inferSelect;

/** Write the first email around an audit and check it: rules, then the analysis model; one rewrite. */
async function writeFirst(o: {
  contact: Contact;
  agency: Agency;
  research: Research;
  facts: Facts;
  kind: string;
  result: SampleResult;
  previewUrl: string;
  writer: string;
}): Promise<{ draft: Draft; notes: string[]; cost: number }> {
  const { contact, agency, research, facts, result } = o;
  const channel = await creatorContext(agency.id);
  const brief = [
    `First name: ${contact.firstName?.trim() || "(unknown)"}`,
    `Agency: ${agency.name} (${agency.website ?? agency.domain})`,
    `Research: ${research.summary ?? ""}`,
    `Services: ${(facts.services ?? []).join(", ") || "-"}; niches: ${(facts.niches ?? []).join(", ") || "-"}; location: ${facts.location ?? "-"}`,
    `Uses GoHighLevel: yes (every agency we write to does); resells white-label: ${facts.resells_white_label ? "yes" : "no"}`,
    ``,
    `The audit (of ${o.kind === "own" ? "the agency's own listing" : "their client"} "${result.title}", ${result.address}):`,
    `Score ${result.score}/100. Verdict: ${result.verdict}`,
    ...(result.gaps ?? []).slice(0, 4).map((g) => `- ${g.label}: ${g.note}`),
    result.standing ? `Standing: ${result.standing}` : "",
    result.rivalNote ? `Rivals: ${result.rivalNote}` : "",
    result.opportunity ? `Opportunity: ${result.opportunity}` : "",
    `Link to the audit: ${o.previewUrl}`,
    channel ? `
${channel}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  let cost = 0;
  let draft: Draft = { subject: "", body: "" };
  let notes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const fix: string = attempt > 0 ? `\n\nYour previous draft:\n${JSON.stringify(draft)}\nFix these problems:\n- ${notes.join("\n- ")}` : "";
    const written = await askJson<Draft>({ model: o.writer, system: WRITER, user: brief + fix, maxTokens: 800 });
    cost += written.usage.costUsd ?? 0;
    draft = { subject: String(written.data.subject ?? "").trim(), body: String(written.data.body ?? "").trim() };

    notes = draftProblems(draft, o.previewUrl);
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
  return { draft, notes, cost };
}

/**
 * Write a first email again — already in Instantly but not yet sent — from the
 * audit it was made with. The message is changed in place only if the new one
 * passes; otherwise the old one stays. The caller updates the Instantly lead.
 */
export async function rewriteFirstEmail(messageId: string): Promise<{ ok: boolean; why?: string }> {
  const [m] = await db().select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!m || m.step !== 1) return { ok: false, why: "no such first email" };
  if (m.sentAt) return { ok: false, why: "already sent" };
  const [row] = await db()
    .select({ contact: contacts, agency: agencies })
    .from(contacts)
    .innerJoin(agencies, eq(agencies.id, contacts.agencyId))
    .where(eq(contacts.id, m.contactId))
    .limit(1);
  const [research] = await db()
    .select()
    .from(agencyResearch)
    .where(eq(agencyResearch.agencyId, row.agency.id))
    .orderBy(desc(agencyResearch.version))
    .limit(1);
  const [sample] = await db().select().from(samples).where(eq(samples.contactId, m.contactId)).orderBy(desc(samples.createdAt)).limit(1);
  if (!research || !sample) return { ok: false, why: "no research or audit" };
  const { draft, notes } = await writeFirst({
    contact: row.contact,
    agency: row.agency,
    research,
    facts: research.facts as unknown as Facts,
    kind: sample.kind,
    result: sample.result as unknown as SampleResult,
    previewUrl: sample.previewUrl,
    writer: m.writerModel,
  });
  if (notes.length) return { ok: false, why: `kept the old one: ${notes.join("; ")}` };
  await db().update(messages).set({ subject: draft.subject, body: draft.body, guardrail: { ok: true, notes: ["rewritten"] } }).where(eq(messages.id, m.id));
  return { ok: true };
}

async function setStatus(agencyId: string, status: string) {
  await db().update(agencies).set({ status, updatedAt: new Date() }).where(eq(agencies.id, agencyId));
}
