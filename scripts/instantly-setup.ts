/**
 * Make the first-email campaign in Instantly (as a draft: it sends nothing until
 * you activate it there), and its webhook if APP_URL and INSTANTLY_WEBHOOK_SECRET
 * are set. Prints the campaign id to put in .env.local as INSTANTLY_CAMPAIGN_ID.
 * The workspace is shared: only mailboxes with our tag (INSTANTLY_TAG) are used,
 * and the campaign gets the tag too.
 *   npm run instantly:setup
 *   npm run instantly:setup -- --accounts       (the campaign exists: re-set its mailboxes and tag)
 *   npm run instantly:setup -- --webhook-only   (the campaign exists: add the webhook)
 */
import { env } from "../src/env";
import {
  createFirstEmailCampaign,
  createWebhook,
  ourTagId,
  sendingAccounts,
  setCampaignAccounts,
  tagCampaign,
} from "../src/lib/instantly";

async function main() {
  let campaignId = env.INSTANTLY_CAMPAIGN_ID;
  const accountsOnly = process.argv.includes("--accounts");
  if (!process.argv.includes("--webhook-only")) {
    if (campaignId && !accountsOnly) {
      throw new Error("INSTANTLY_CAMPAIGN_ID is already set; use --accounts or --webhook-only, or clear it to make another.");
    }
    const tagId = await ourTagId();
    const accounts = await sendingAccounts(tagId);
    if (accounts.length === 0) throw new Error(`No active mailboxes tagged "${env.INSTANTLY_TAG}" in Instantly.`);
    if (campaignId) {
      const c = await setCampaignAccounts(campaignId, accounts);
      console.log(`Campaign now sends from ${c.email_list?.length ?? accounts.length} mailboxes tagged "${env.INSTANTLY_TAG}".`);
    } else {
      const c = await createFirstEmailCampaign("GBP Autopilot — first email", accounts);
      campaignId = c.id;
      console.log(`Campaign made (status ${c.status}, 0 = draft) with ${accounts.length} mailboxes tagged "${env.INSTANTLY_TAG}".`);
      console.log(`Add to .env.local:  INSTANTLY_CAMPAIGN_ID=${c.id}`);
    }
    await tagCampaign(tagId, campaignId);
    console.log(`Campaign tagged "${env.INSTANTLY_TAG}".`);
  }
  if (!campaignId) throw new Error("No campaign id.");
  if (accountsOnly) process.exit(0);
  if (env.APP_URL && env.INSTANTLY_WEBHOOK_SECRET) {
    await createWebhook(campaignId, `${env.APP_URL.replace(/\/$/, "")}/api/instantly-events`, env.INSTANTLY_WEBHOOK_SECRET);
    console.log("Webhook made: Instantly will report sends, replies, bounces and unsubscribes.");
  } else {
    console.log("No webhook yet: set APP_URL (the deployed app) and INSTANTLY_WEBHOOK_SECRET, then run with --webhook-only.");
  }
  process.exit(0);
}
main();
