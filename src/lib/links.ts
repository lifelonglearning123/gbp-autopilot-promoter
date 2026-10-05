import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/**
 * Signed links for the owner's emails: stop a draft, pause, resume. A link
 * only opens a confirm page (mail scanners open links on their own); the
 * button there does the action.
 */

export type Action = "stop" | "pause" | "resume";

function sign(action: Action, id: string): string {
  if (!env.ACTION_SECRET) throw new Error("ACTION_SECRET is not set.");
  return createHmac("sha256", env.ACTION_SECRET).update(`${action}:${id}`).digest("base64url").slice(0, 32);
}

export function actionLink(action: Action, id = "-"): string {
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  return `${base}/act?a=${action}&id=${encodeURIComponent(id)}&s=${sign(action, id)}`;
}

export function signatureOk(action: string, id: string, s: string | null): boolean {
  if (!["stop", "pause", "resume"].includes(action) || !s || !env.ACTION_SECRET) return false;
  const want = Buffer.from(sign(action as Action, id));
  const got = Buffer.from(s);
  return want.length === got.length && timingSafeEqual(want, got);
}
