import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agencies, contacts, events } from "@/db/schema";
import { env } from "@/env";
import { signedByPlatform } from "@/lib/platform";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Events from the GBP Autopilot platform (its BOT_WEBHOOK_URL points here):
 * sample.viewed, agency.signed_up, free_audit.used, subscription.changed.
 * `externalRef` is our contact id. Stored as-is; the learning loop and the
 * follow-up emails read them from `events`.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!signedByPlatform(raw, req.headers.get("x-signature"), env.PLATFORM_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "not JSON" }, { status: 400 });
  }
  const type = typeof event.type === "string" ? event.type : "unknown";
  const ref = typeof event.externalRef === "string" && UUID.test(event.externalRef) ? event.externalRef : null;

  const [contact] = ref
    ? await db().select({ id: contacts.id, agencyId: contacts.agencyId }).from(contacts).where(eq(contacts.id, ref)).limit(1)
    : [];

  await db().insert(events).values({
    source: "platform",
    type,
    contactId: contact?.id ?? null,
    agencyId: contact?.agencyId ?? null,
    payload: event,
  });

  if (contact && type === "agency.signed_up" && typeof event.agencyId === "string") {
    await db()
      .update(agencies)
      .set({ platformAgencyId: event.agencyId, status: "claimed", updatedAt: new Date() })
      .where(eq(agencies.id, contact.agencyId));
  }
  if (contact && type === "subscription.changed" && event.status === "active") {
    await db().update(agencies).set({ status: "customer", updatedAt: new Date() }).where(eq(agencies.id, contact.agencyId));
  }

  return NextResponse.json({ ok: true });
}
