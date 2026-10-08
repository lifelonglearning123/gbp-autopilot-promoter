/**
 * What is true about GBP Autopilot, said once: the writers may use it and the
 * checkers accept it. Every agency we write to runs on GoHighLevel, and the
 * platform works with the agency's own GHL (gbp-platform: lib/gbp/ghl-push.ts,
 * lib/gbp/crm.ts) — so that is the strongest thing to say to them.
 */
export const OFFER_FACTS = `GBP Autopilot is a white-label platform agencies resell to local businesses under their own brand: it audits and scores each client's Google Business Profile and improves it, answers reviews, posts weekly and reports. From £149 a month. Three free audits once the agency claims its account. The sample audit we made was in the agency's own brand (its name, logo and colour).
Every agency we write to uses GoHighLevel (GHL), and GBP Autopilot is built to work with the agency's own GHL: each audit lands in the agency's GHL sub-account as a contact with the findings as a note and the work to do as a task, and the weekly Google posts draw on what is actually happening in the client's GHL (with customers' personal details removed). Do not claim it is made by HighLevel, is a HighLevel marketplace app, or is an official partner.`;

/**
 * The creator offer (the owner's terms, 2026-10-06): a content creator gets
 * their own white-label GBP Autopilot in their brand at no cost; local
 * businesses from their audience sign up on it at £49 a month, and the creator
 * earns 40% of what each pays, for life. They claim it from the link in the
 * email (the platform makes it a creator account: offer "creator").
 */
export const PARTNER_FACTS = `The creator offer: a content creator gets their own white-label GBP Autopilot, under their own brand (their name and logo), at no cost to them: no fee, no minimum, nothing to pay. Local businesses from their audience sign up on the creator's branded version for £49 a month; it fills in the business's Google Business Profile, replies to every review in the owner's voice, posts weekly, tracks map rankings and sends a monthly report. The creator earns 40% of what every business pays, for life (as long as that business stays a customer): about £19.60 a month per business. We do all the work; the creator just points their audience to it. They set it up by claiming their account from the claim link. Do not claim other terms (payout dates, cookie length, bonuses, tiers, caps).`;

/**
 * Where an agency is decides its price and spelling (the owner's terms,
 * 2026-10-08): US agencies pay $199 a month and get US English, everyone else
 * £149 a month and UK English. The country comes from the agency's own site.
 */
export type Market = "UK" | "US";
export const marketOf = (country: string | null | undefined): Market => (country?.trim().toUpperCase() === "US" ? "US" : "UK");
export const AGENCY_PRICE: Record<Market, string> = { UK: "£149 a month", US: "$199 a month" };

/** A prompt or email written for the UK, as it should read for this market. */
export function forMarket(text: string, m: Market): string {
  if (m === "UK") return text;
  return text.replace(/£149 a month/g, AGENCY_PRICE.US).replace(/UK English/g, "US English");
}
