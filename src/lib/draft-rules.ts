/**
 * Pure rules for first-email drafts, pinned by scripts/verify.ts.
 */

type ResearchFacts = {
  best_sample?: "own" | "client" | "prospect";
  location?: string | null;
  case_study_clients?: { name: string; town: string | null }[];
};

export type SampleTarget = { kind: "own" | "client"; name: string; town: string };

/** "Leeds, United Kingdom" → "Leeds". */
export function townOf(location: string | null | undefined): string | null {
  const town = (location ?? "").split(",")[0].trim();
  return town.length >= 2 ? town : null;
}

/**
 * Which business the sample audit is of. The research's pick comes first; a
 * named client needs a town to be found on Maps; the agency's own listing needs
 * its location. "prospect" has no business named yet, so it falls back to
 * whichever of the other two the pages support. Null: nothing to audit.
 */
export function pickSampleTarget(agencyName: string, facts: ResearchFacts): SampleTarget | null {
  const town = townOf(facts.location);
  const client = (facts.case_study_clients ?? []).find((c) => c.name?.trim() && townOf(c.town));
  const own = town ? ({ kind: "own", name: agencyName, town } as const) : null;
  const viaClient = client ? ({ kind: "client", name: client.name.trim(), town: townOf(client.town)! } as const) : null;
  return facts.best_sample === "client" ? (viaClient ?? own) : (own ?? viaClient);
}

const LEGAL = new Set(["llc", "inc", "ltd", "limited", "co", "corp", "plc", "the", "and", "of"]);
const words = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !LEGAL.has(w));

/**
 * Is the listing the platform audited the business we asked for? Every
 * meaningful word of our name must be in the listing's ("Digital Marketing
 * Inc." is not the nightclub "Digital"); names written together or apart
 * ("PearPixels" / "Pear Pixels") also count.
 */
export function sameBusiness(asked: string, found: string): boolean {
  const want = words(asked);
  const got = words(found);
  if (want.length === 0 || got.length === 0) return false;
  if (want.every((w) => got.includes(w))) return true;
  return got.join("").includes(want.join(""));
}

export const MAX_WORDS = 130;
export const MAX_SUBJECT = 60;

/**
 * Checks a draft must pass before any model judges it: the offer named, the
 * sample link once and no other link, short, a calm subject, and no template
 * left unfilled.
 */
export function draftProblems(d: { subject: string; body: string }, previewUrl: string): string[] {
  const problems: string[] = [];
  const subject = (d.subject ?? "").trim();
  const body = (d.body ?? "").trim();
  if (!subject) problems.push("no subject");
  if (subject.length > MAX_SUBJECT) problems.push(`subject over ${MAX_SUBJECT} characters`);
  if (/!/.test(subject) || /\b[A-Z]{4,}\b/.test(subject)) problems.push("subject shouts (! or capitals)");
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) problems.push(`body is ${words} words (max ${MAX_WORDS})`);
  if (!/white[- ]label/i.test(body)) problems.push('does not say "white-label": the offer must be plain');
  const links = body.match(/https?:\/\/\S+/g) ?? [];
  const toSample = links.filter((l) => l.replace(/[).,;:!?]+$/, "") === previewUrl).length;
  if (toSample !== 1) problems.push(`the sample link appears ${toSample} times (want 1)`);
  if (links.length !== toSample) problems.push("a link other than the sample");
  if (/\{\{|\}\}|\[(first ?name|name|agency)\]/i.test(subject + body)) problems.push("an unfilled placeholder");
  return problems;
}
