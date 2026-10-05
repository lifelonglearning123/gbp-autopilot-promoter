"use server";

import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { env } from "@/env";
import { pauseAll, resumeAll } from "@/lib/control";
import { signatureOk } from "@/lib/links";
import { stopDraft } from "@/lib/pipeline";

/**
 * What the owner can do: from a signed email link (after a confirm click) or
 * from the dashboard once logged in.
 */

const COOKIE = "promoter_owner";

function ownerToken(): string | null {
  if (!env.DASHBOARD_PASSWORD) return null;
  return createHmac("sha256", env.DASHBOARD_PASSWORD).update("owner").digest("base64url");
}

export async function isOwner(): Promise<boolean> {
  const want = ownerToken();
  return !!want && (await cookies()).get(COOKIE)?.value === want;
}

export async function logIn(form: FormData) {
  const want = ownerToken();
  if (!want || form.get("password") !== env.DASHBOARD_PASSWORD) redirect("/dashboard?wrong=1");
  (await cookies()).set(COOKIE, want, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30, path: "/" });
  redirect("/dashboard");
}

async function act(action: string, id: string, by: string) {
  if (action === "stop") await stopDraft(id);
  else if (action === "pause") await pauseAll("paused by you", by);
  else if (action === "resume") await resumeAll(by);
}

/** From an email link: the signature is the permission. */
export async function confirmLink(form: FormData) {
  const action = String(form.get("a") ?? "");
  const id = String(form.get("id") ?? "-");
  if (!signatureOk(action, id, String(form.get("s") ?? ""))) redirect("/act?done=bad");
  await act(action, id, "email link");
  redirect(`/act?done=${action}`);
}

/** From the dashboard: the login is the permission. */
export async function dashboardAction(form: FormData) {
  if (!(await isOwner())) redirect("/dashboard");
  await act(String(form.get("a") ?? ""), String(form.get("id") ?? "-"), "dashboard");
  revalidatePath("/dashboard");
}
