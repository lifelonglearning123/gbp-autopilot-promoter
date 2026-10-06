/**
 * Pure rules for first-email drafts, pinned by scripts/verify.ts.
 */

type ResearchFacts = {
  best_sample?: "own" | "client" | "prospect";
  location?: string | null;
  case_study_clients?: { name: string; town: string | null }[];
};

/** town "" (or only a country): Google is searched by the name alone. */
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

/** "Leeds, West Yorkshire, UK" → "UK"; null when the location is only a town. */
export function countryOf(location: string | null | undefined): string | null {
  const parts = (location ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/**
 * Every business worth trying, best first: the research's pick, then the
 * agency's own listing searched by name alone (with its country if known),
 * which finds agencies whose site never says where they are.
 */
export function sampleTargets(agencyName: string, facts: ResearchFacts, country?: string | null): SampleTarget[] {
  const first = pickSampleTarget(agencyName, facts);
  const byName: SampleTarget = { kind: "own", name: agencyName, town: countryOf(facts.location) ?? country?.trim() ?? "" };
  return first && first.kind === "own" && first.town === byName.town ? [first] : [first, byName].filter((t): t is SampleTarget => !!t);
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

/* ── Follow-ups (steps 2-4, sent as replies in the same thread) ───────── */

export type FollowUps = { body_2: string; body_3: string; body_4: string };
export const FOLLOW_UP_MAX_WORDS = { body_2: 80, body_3: 120, body_4: 60 } as const;

/**
 * Rules a follow-up set must pass before any model judges it: short, only our
 * two links (the audit, the claim link), step 3 carries the claim link when
 * there is one, nothing left unfilled.
 */
export function followUpProblems(f: FollowUps, previewUrl: string, claimUrl: string | null): string[] {
  const problems: string[] = [];
  const ours = new Set([previewUrl, claimUrl].filter(Boolean));
  for (const key of ["body_2", "body_3", "body_4"] as const) {
    const body = (f[key] ?? "").trim();
    if (!body) {
      problems.push(`${key} is empty`);
      continue;
    }
    const words = body.split(/\s+/).length;
    if (words > FOLLOW_UP_MAX_WORDS[key]) problems.push(`${key} is ${words} words (max ${FOLLOW_UP_MAX_WORDS[key]})`);
    const links = (body.match(/https?:\/\/\S+/g) ?? []).map((l) => l.replace(/[).,;:!?]+$/, ""));
    if (links.some((l) => !ours.has(l))) problems.push(`${key} has a link that is not the audit or the claim link`);
    if (/\{\{|\}\}|\[(first ?name|name|agency|link)\]/i.test(body)) problems.push(`${key} has an unfilled placeholder`);
  }
  const want = claimUrl ?? previewUrl;
  if (!(f.body_3 ?? "").includes(want)) problems.push(`body_3 must include ${claimUrl ? "the claim link" : "the audit link"}`);
  return problems;
}

/** Safe follow-ups from facts alone, for when the writer's fail the check twice. */
export function templateFollowUps(o: { firstName: string | null; finding: string | null; previewUrl: string; claimUrl: string | null }): FollowUps {
  const hi = o.firstName?.trim() ? `Hi ${o.firstName.trim()},` : "Hi there,";
  return {
    body_2: `${hi}\n\nOne more thing from the audit${o.finding ? `: ${o.finding.replace(/\.$/, "")}.` : "."} It's the kind of fix your clients would see in the first month.\n\n${o.previewUrl}\n\nWorth a look?`,
    body_3: `${hi}\n\nHow it works: you sell Google Business Profile management to your local clients under your own brand, and we do the work behind it: audits, fixes, review replies, weekly posts and reports. It works with the GoHighLevel you already use, so each audit lands in your sub-account with the findings and the tasks. From £149 a month, and your first three client audits are free.\n\nYou can claim your account here:\n${o.claimUrl ?? o.previewUrl}\n\nWould that fit what you offer?`,
    body_4: `${hi}\n\nI'll leave it here so I'm not filling your inbox. If white-label Google Business Profile work becomes useful for your clients, just reply and I'll pick it up.`,
  };
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

/* ── Creator partners (the 40% offer): first email + three follow-ups ──── */

export type PartnerEmails = { subject: string; body: string; body_2: string; body_3: string; body_4: string };
export const PARTNER_MAX_WORDS = { body: 130, body_2: 80, body_3: 110, body_4: 60 } as const;

/**
 * Rules a partner sequence must pass before any model judges it: the 40% and
 * "lifetime" said plainly in the first email, the product link once there and
 * no link other than it anywhere, short, a calm subject, nothing unfilled.
 */
export function partnerProblems(p: PartnerEmails, productUrl: string): string[] {
  const problems: string[] = [];
  const subject = (p.subject ?? "").trim();
  if (!subject) problems.push("no subject");
  if (subject.length > MAX_SUBJECT) problems.push(`subject over ${MAX_SUBJECT} characters`);
  if (/!/.test(subject) || /\b[A-Z]{4,}\b/.test(subject)) problems.push("subject shouts (! or capitals)");
  const host = productUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  for (const key of ["body", "body_2", "body_3", "body_4"] as const) {
    const body = (p[key] ?? "").trim();
    if (!body) {
      problems.push(`${key} is empty`);
      continue;
    }
    const words = body.split(/\s+/).length;
    if (words > PARTNER_MAX_WORDS[key]) problems.push(`${key} is ${words} words (max ${PARTNER_MAX_WORDS[key]})`);
    const links = (body.match(/https?:\/\/\S+/g) ?? []).map((l) => l.replace(/[).,;:!?]+$/, ""));
    if (links.some((l) => l.replace(/^https?:\/\//, "").replace(/\/$/, "") !== host)) problems.push(`${key} has a link other than ${productUrl}`);
    if (/\{\{|\}\}|\[(first ?name|name|channel|link)\]/i.test(body)) problems.push(`${key} has an unfilled placeholder`);
  }
  const first = (p.body ?? "").trim();
  if (!/40\s?%/.test(first)) problems.push("the first email does not say 40%");
  if (!/life|lifetime|for as long as/i.test(first)) problems.push("the first email does not say the commission is for life");
  const toProduct = (first.match(/https?:\/\/\S+/g) ?? []).length;
  if (toProduct !== 1) problems.push(`the product link appears ${toProduct} times in the first email (want 1)`);
  return problems;
}
