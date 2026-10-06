/**
 * Make the creator partners' Instantly campaign (the 40% local.macaws.ai offer): the same four-step sequence,
 * footer and mailboxes as the main one, its own name and daily limit, tagged
 * for us, with the webhook. Created as a draft (sends nothing until activated).
 *   npm run partners:setup -- --daily 20
 * Prints the id to put in .env.local as INSTANTLY_PARTNER_CAMPAIGN_ID.
 */
import { env } from "../src/env";
import {
  createFirstEmailCampaign,
  createWebhook,
  ourTagId,
  sendingAccounts,
  sequenceSteps,
  setCampaignSequence,
  tagCampaign,
} from "../src/lib/instantly";

async function main() {
  if (env.INSTANTLY_PARTNER_CAMPAIGN_ID) throw new Error("INSTANTLY_PARTNER_CAMPAIGN_ID is already set.");
  if (!env.SENDER_LEGAL) throw new Error("SENDER_LEGAL is not set.");
  const i = process.argv.indexOf("--daily");
  const daily = i > 0 ? Number(process.argv[i + 1]) || 20 : 20;
  const tagId = await ourTagId();
  const accounts = await sendingAccounts(tagId);
  const c = await createFirstEmailCampaign("macaws.ai — creator partners", accounts, daily);
  const lines = (s: string) => s.replace(/\\n/g, "\n");
  await setCampaignSequence(c.id, sequenceSteps(lines(env.SENDER_SIGNOFF), lines(env.SENDER_LEGAL)));
  await tagCampaign(tagId, c.id);
  if (env.APP_URL && env.INSTANTLY_WEBHOOK_SECRET) {
    await createWebhook(c.id, `${env.APP_URL.replace(/\/$/, "")}/api/instantly-events`, env.INSTANTLY_WEBHOOK_SECRET);
  }
  console.log(`Campaign made (draft, ${daily} a day, ${accounts.length} mailboxes, 4 steps, webhook on).`);
  console.log(`Add to .env.local:  INSTANTLY_PARTNER_CAMPAIGN_ID=${c.id}`);
  process.exit(0);
}
main();
