/** Is the platform's bot API on, and does it accept our key? Prints status only. */
import { env } from "../src/env";

async function main() {
  const res = await fetch(`${env.PLATFORM_URL}/api/bot/claim-link`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.PLATFORM_BOT_API_KEY ?? "" },
    body: JSON.stringify({ agencyName: "Test Agency", email: "test@example.com", externalRef: "ping" }),
  });
  const body = (await res.json().catch(() => ({}))) as { claimUrl?: string; error?: string };
  console.log(res.status, body.claimUrl ? "OK: the platform accepted our key" : body.error ?? "");
}
main();
