/**
 * Import the GHL agency list (contacts tagged `ghl-agency`) into the bot's database.
 *
 *   npm run import:ghl              → imports (needs DATABASE_URL)
 *   npm run import:ghl -- --dry-run → reads GHL and reports, writes nothing
 *
 * The hourly run does the same once a day. Prints counts only — never names, emails or keys.
 */
import { env } from "../src/env";
import { GHL_TAG, importGhl } from "../src/lib/import-ghl";

const dryRun = process.argv.includes("--dry-run") || !env.DATABASE_URL;

importGhl({ write: !dryRun })
  .then((c) => {
    console.log(`GHL contacts tagged ${GHL_TAG}: ${c.inGhl}`);
    console.log(`  usable emails ${c.usable} (no email ${c.noEmail}), free-mail ${c.free}`);
    console.log(`  GHL says invalid ${c.ghlInvalid}, do-not-disturb ${c.dnd}, distinct agencies ${c.agencies}`);
    console.log(dryRun ? "\nDry run: nothing written." : `\nWritten: ${c.newAgencies} new agencies, ${c.newContacts} new contacts.`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
