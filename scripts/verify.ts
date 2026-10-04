/**
 * Pins the pure rules, with no database, network or keys. Run: npm run verify
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { agencyKey, domainOf, emailType, tidyEmail } from "../src/lib/contact-rules";
import { signedByPlatform } from "../src/lib/platform";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("Contacts");
check("free-mail is told apart from work email", () => {
  assert.equal(emailType("jo@gmail.com"), "free");
  assert.equal(emailType("Jo@BTInternet.com"), "free");
  assert.equal(emailType("jo@hotmail.co.uk"), "free");
  assert.equal(emailType("jo@acme-digital.co.uk"), "work");
  assert.equal(emailType("jo@mailchimp.com"), "work", "a domain starting 'mail' is not a mailbox provider");
});
check("a website becomes its bare domain", () => {
  assert.equal(domainOf("https://www.Acme-Digital.co.uk/about?x=1"), "acme-digital.co.uk");
  assert.equal(domainOf("acme.io"), "acme.io");
  assert.equal(domainOf("not a site"), null);
  assert.equal(domainOf(""), null);
});
check("an agency is keyed by site, else work email, never a free-mail domain", () => {
  assert.equal(agencyKey("https://acme.io", "jo@gmail.com"), "acme.io");
  assert.equal(agencyKey(null, "jo@acme.io"), "acme.io");
  assert.equal(agencyKey(null, "Jo@Gmail.com"), "email:jo@gmail.com");
});
check("emails are tidied or refused", () => {
  assert.equal(tidyEmail("  Jo@Acme.IO "), "jo@acme.io");
  assert.equal(tidyEmail("nope"), null);
  assert.equal(tidyEmail(null), null);
});

console.log("\nPlatform events");
check("only a body signed with our secret is accepted", () => {
  const body = JSON.stringify({ type: "sample.viewed" });
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(signedByPlatform(body, sig, "s3cret"), true);
  assert.equal(signedByPlatform(body + " ", sig, "s3cret"), false);
  assert.equal(signedByPlatform(body, sig, "other"), false);
  assert.equal(signedByPlatform(body, sig, undefined), false);
  assert.equal(signedByPlatform(body, null, "s3cret"), false);
});

console.log(`\n${passed} checks passed`);
