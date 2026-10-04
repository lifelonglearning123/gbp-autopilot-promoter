import { NextResponse } from "next/server";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, events, messages, replies, suppression } from "@/db/schema";
import { env } from "@/env";
import { WEBHOOK_HEADER, webhookSecretOk } from "@/lib/instantly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Events from Instantly (the webhook npm run instantly:setup made). Instantly
 * signs nothing, so it sends our own secret as a header. Every event is kept in
 * `events`; the ones that change what we do next are acted on here:
 * sent → the message's sent_at and the agency "contacted"; a reply → `replies`
 * and the agency "replied"; a bounce or unsubscribe → never write again.
 */

/** Statuses a later email event must not pull an agency back from. */
const FURTHER = ["replied", "claimed", "customer", "lost", "suppressed"];

export async function POST(req: Request) {
  if (!webhookSecretOk(req.headers.get(WEBHOOK_HEADER), env.INSTANTLY_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "bad secret" }, { status: 401 });
  }
  let e: Record<string, unknown>;
  try {
    e = await req.json();
  } catch {
    return NextResponse.json({ error: "not JSON" }, { status: 400 });
  }
  const type = typeof e.event_type === "string" ? e.event_type : "unknown";
  const email = typeof e.lead_email === "string" ? e.lead_email.trim().toLowerCase() : null;
  const at = typeof e.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)) ? new Date(e.timestamp) : new Date();

  const [contact] = email
    ? await db().select({ id: contacts.id, agencyId: contacts.agencyId }).from(contacts).where(eq(contacts.email, email)).limit(1)
    : [];

  // Bodies of sent emails are already ours; keep the event small.
  const { email_html: _h, email_text: _t, reply_html: _r, ...payload } = e;
  await db().insert(events).values({
    source: "instantly",
    type,
    contactId: contact?.id ?? null,
    agencyId: contact?.agencyId ?? null,
    payload,
    at,
  });
  if (!contact) return NextResponse.json({ ok: true, matched: false });

  const setAgency = (status: string, unless: string[]) =>
    db()
      .update(agencies)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(agencies.id, contact.agencyId), notInArray(agencies.status, unless)));

  if (type === "email_sent") {
    const step = typeof e.step === "number" ? e.step : 1;
    await db()
      .update(messages)
      .set({ sentAt: at })
      .where(and(eq(messages.contactId, contact.id), eq(messages.step, step), isNull(messages.sentAt)));
    await setAgency("contacted", ["contacted", ...FURTHER]);
  } else if (type === "reply_received") {
    const body = String(e.reply_text ?? e.reply_text_snippet ?? "").trim();
    await db().insert(replies).values({ contactId: contact.id, body: body || "(empty reply)", receivedAt: at });
    await setAgency("replied", FURTHER);
  } else if (type === "email_bounced" || type === "lead_unsubscribed") {
    const reason = type === "email_bounced" ? "bounced" : "unsubscribed";
    await db().insert(suppression).values({ email, reason }).onConflictDoNothing();
    if (type === "email_bounced") {
      await db().update(contacts).set({ emailStatus: "invalid", updatedAt: new Date() }).where(eq(contacts.id, contact.id));
    } else {
      await setAgency("suppressed", ["claimed", "customer"]);
    }
    // Anything still waiting for them stays unsent.
    await db()
      .update(messages)
      .set({ guardrail: { ok: false, notes: [`contact ${reason}`] } })
      .where(and(eq(messages.contactId, contact.id), isNull(messages.pushedAt)));
  }
  return NextResponse.json({ ok: true });
}
