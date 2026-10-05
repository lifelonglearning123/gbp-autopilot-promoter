import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The sales bot's own records. Nothing here is the platform's: an agency that
 * signs up gets a workspace on gbp.macaws.ai, and we only keep its id from the
 * events the platform sends back.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** One row per agency we might write to, keyed by its web domain. */
export const agencies = pgTable(
  "agencies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    /** "acme-digital.co.uk": the website's host without www, else the work email's domain. */
    domain: text("domain").notNull(),
    website: text("website"),
    country: text("country"),
    /** new → researched → queued → contacted → replied / claimed → customer; or skipped / lost / suppressed. */
    status: text("status").notNull().default("new"),
    fitScore: integer("fit_score"),
    branding: jsonb("branding").$type<{ logoUrl: string | null; colour: string | null }>(),
    /** The workspace on the platform, once the agency signed up. */
    platformAgencyId: uuid("platform_agency_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("agencies_domain_idx").on(t.domain), index("agencies_status_idx").on(t.status)],
);

/**
 * Research is kept for good: every run is a new version, never an overwrite,
 * so what we knew about an agency at any point can be read back later.
 */
export const agencyResearch = pgTable(
  "agency_research",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    researchedAt: timestamp("researched_at", { withTimezone: true }).notNull().defaultNow(),
    pagesCrawled: jsonb("pages_crawled").$type<string[]>().notNull().default([]),
    /** The pages' text as read, kept so the research can be re-read or re-scored later. */
    rawText: text("raw_text"),
    /** What else the pages gave: logo candidates, theme colour, emails published on them. */
    signals: jsonb("signals").$type<Record<string, unknown>>().notNull().default({}),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull().default({}),
    summary: text("summary"),
    fitScore: integer("fit_score"),
    fitReasoning: text("fit_reasoning"),
    model: text("model"),
  },
  (t) => [uniqueIndex("agency_research_version_idx").on(t.agencyId, t.version)],
);

/** A person at an agency. Their id is the externalRef the platform echoes back. */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email").notNull(),
    /** work | free (Gmail, Hotmail…: likely a sole trader). */
    emailType: text("email_type").notNull(),
    /** unverified | valid | risky | invalid */
    emailStatus: text("email_status").notNull().default("unverified"),
    phone: text("phone"),
    country: text("country"),
    /** Where we got them, e.g. "ghl:Cold outreach (ghl-list-v1)". */
    source: text("source").notNull(),
    /** For CASL: the page the address was published on, and when we saw it. */
    sourceProof: jsonb("source_proof").$type<{ url: string; seenAt: string }>(),
    ghlContactId: text("ghl_contact_id"),
    /** Assigned once, for the whole conversation, from WRITER_MODELS (e.g. moonshotai/kimi-k3). */
    writerModel: text("writer_model"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contacts_email_idx").on(t.email),
    uniqueIndex("contacts_ghl_idx").on(t.ghlContactId),
    index("contacts_agency_idx").on(t.agencyId),
  ],
);

/** Sample audits the platform made for us (POST /api/bot/sample). */
export const samples = pgTable(
  "samples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** own | client | prospect: which business was audited (an experiment). */
    kind: text("kind").notNull(),
    platformToken: text("platform_token").notNull(),
    previewUrl: text("preview_url").notNull(),
    claimUrl: text("claim_url"),
    score: integer("score"),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("samples_token_idx").on(t.platformToken)],
);

export const experiments = pgTable("experiments", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** running | finished */
  status: text("status").notNull().default("running"),
  ...timestamps,
});

/** One arm of an experiment, with its Beta(alpha, beta) for the bandit. */
export const variants = pgTable("variants", {
  id: uuid("id").defaultRandom().primaryKey(),
  experimentId: uuid("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hookType: text("hook_type"),
  subjectStyle: text("subject_style"),
  instantlyCampaignId: text("instantly_campaign_id"),
  alpha: real("alpha").notNull().default(1),
  beta: real("beta").notNull().default(1),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

/** Every email written, by which model, and what the checker said. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => variants.id, { onDelete: "set null" }),
    writerModel: text("writer_model").notNull(),
    step: integer("step").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    guardrail: jsonb("guardrail").$type<{ ok: boolean; notes: string[] }>(),
    /** Not pushed before this: the owner's window to stop it (HOLD_HOURS after drafting). */
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    /** The owner stopped this draft; it is never pushed. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    /** Handed to Instantly as a lead in this campaign; Instantly decides when it goes. */
    instantlyCampaignId: text("instantly_campaign_id"),
    instantlyLeadId: text("instantly_lead_id"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    /** Set by Instantly's email_sent event, not when pushed. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_contact_idx").on(t.contactId)],
);

/** Everything that happened, from any source. The learning loop reads this. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    agencyId: uuid("agency_id").references(() => agencies.id, { onDelete: "set null" }),
    /** platform | instantly | bot */
    source: text("source").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_type_idx").on(t.type), index("events_contact_idx").on(t.contactId)],
);

export const replies = pgTable("replies", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  classification: text("classification"),
  confidence: real("confidence"),
  handled: boolean("handled").notNull().default(false),
  /** When the owner was told about it (interested replies). */
  alertedAt: timestamp("alerted_at", { withTimezone: true }),
  escalated: boolean("escalated").notNull().default(false),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const playbookVersions = pgTable(
  "playbook_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    changeReason: text("change_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("playbook_version_idx").on(t.version)],
);

/** What you told the bot, and the rule it became. */
export const feedback = pgTable("feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** email | whatsapp */
  channel: text("channel").notNull(),
  rawText: text("raw_text").notNull(),
  parsedRule: text("parsed_rule"),
  appliedVersion: integer("applied_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Never contact again. Checked before every send; synced to Instantly and GHL. */
export const suppression = pgTable(
  "suppression",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email"),
    domain: text("domain"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppression_email_idx").on(t.email), index("suppression_domain_idx").on(t.domain)],
);

/** Switches the owner controls, e.g. "paused". One row per key. */
export const controls = pgTable("controls", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Agency = typeof agencies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
