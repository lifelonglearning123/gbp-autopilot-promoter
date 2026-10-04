/**
 * Make the first-email campaign in Instantly (as a draft: it sends nothing until
 * you activate it there), and its webhook if APP_URL and INSTANTLY_WEBHOOK_SECRET
 * are set. Prints the campaign id to put in .env.local as INSTANTLY_CAMPAIGN_ID.
 *   npm run instantly:setup
 *   npm run instantly:setup -- --webhook-only   (the campaign exists; add the webhook)
 */
import { env } from "../src/env";
import { createFirstEmailCampaign, createWebhook, sendingAccounts } from "../src/lib/instantly";

async function main() {
  let campaignId = env.INSTANTLY_CAMPAIGN_ID;
  if (!process.argv.includes("--webhook-only")) {
    if (campaignId) throw new Error("INSTANTLY_CAMPAIGN_ID is already set; use --webhook-only, or clear it to make another.");
    const accounts = await sendingAccounts();
    if (accounts.length === 0) throw new Error("No active sending accounts in Instantly.");
    const c = await createFirstEmailCampaign("GBP Autopilot — first email", accounts);
    campaignId = c.id;
    console.log(`Campaign made (status ${c.status}, 0 = draft) with ${accounts.length} sending accounts.`);
    console.log(`Add to .env.local:  INSTANTLY_CAMPAIGN_ID=${c.id}`);
  }
  if (!campaignId) throw new Error("No campaign id.");
  if (env.APP_URL && env.INSTANTLY_WEBHOOK_SECRET) {
    await createWebhook(campaignId, `${env.APP_URL.replace(/\/$/, "")}/api/instantly-events`, env.INSTANTLY_WEBHOOK_SECRET);
    console.log("Webhook made: Instantly will report sends, replies, bounces and unsubscribes.");
  } else {
    console.log("No webhook yet: set APP_URL (the deployed app) and INSTANTLY_WEBHOOK_SECRET, then run with --webhook-only.");
  }
  process.exit(0);
}
main();
