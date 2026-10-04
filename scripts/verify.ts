/**
 * Pins the pure rules, with no database, network or keys. Run: npm run verify
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { agencyKey, domainOf, emailType, tidyEmail } from "../src/lib/contact-rules";
import { signedByPlatform } from "../src/lib/platform";
import { internalLinks, logoCandidates, pageText, pickPages, publishedEmails, themeColour } from "../src/lib/crawl-rules";
import { bodyHtml, foldVerdict, webhookSecretOk } from "../src/lib/instantly";
import { foldGhlVerdict } from "../src/lib/ghl";
import { draftProblems, pickSampleTarget, townOf } from "../src/lib/draft-rules";

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

console.log("\nReading websites");
const HTML = `<html><head><title>Acme &amp; Co</title><meta name="theme-color" content="#0E9F6E">
<link rel="icon" href="/fav.png"><meta property="og:image" content="https://acme.io/og.jpg"></head>
<body><script>var x=1</script><header><img class="site-logo" src="/img/logo.png"></header>
<nav><a href="/services/local-seo">Local SEO</a><a href="/blog/post-1">Blog</a><a href="/about-us">About</a>
<a href="https://other.com/x">Out</a><a href="/case-studies#top">Cases</a><a href="/brochure.pdf">PDF</a></nav>
<p>We help trades win on Google Maps.</p><p>Email hello@acme.io or logo@2x.png</p></body></html>`;
check("page text drops scripts and markup", () => {
  const t = pageText(HTML);
  assert.ok(t.includes("We help trades win on Google Maps."));
  assert.ok(!t.includes("var x"));
});
check("only same-site pages are followed, and the useful ones first", () => {
  const links = internalLinks(HTML, "https://www.acme.io/");
  assert.ok(!links.some((l) => l.includes("other.com") || l.endsWith(".pdf")));
  const picked = pickPages(links);
  assert.equal(picked[0], "https://www.acme.io/services/local-seo");
  assert.ok(!picked.some((l) => l.includes("/blog")), "blog posts are not research");
});
check("logo, colour and published emails are read off the page", () => {
  const logos = logoCandidates(HTML, "https://acme.io/");
  assert.equal(logos[0], "https://acme.io/img/logo.png");
  assert.ok(logos.includes("https://acme.io/og.jpg"));
  assert.equal(themeColour(HTML), "#0e9f6e");
  assert.deepEqual(publishedEmails(HTML), ["hello@acme.io"]);
});

console.log("\nEmail verification");
check("a catch-all 'valid' is only risky", () => {
  assert.equal(foldVerdict({ verification_status: "verified", catch_all: false }), "valid");
  assert.equal(foldVerdict({ verification_status: "verified", catch_all: true }), "risky");
  assert.equal(foldVerdict({ verification_status: "invalid" }), "invalid");
  assert.equal(foldVerdict({ verification_status: "pending" }), "pending");
  assert.equal(foldVerdict({ verification_status: "something new" }), "risky");
});
check("GHL: deliverable and low risk is valid; catch-all is risky; a role inbox is fine", () => {
  assert.equal(foldGhlVerdict({ result: "deliverable", risk: "low", reason: ["mailbox_is_role_address"] }), "valid");
  assert.equal(foldGhlVerdict({ result: "deliverable", risk: "low", reason: ["accept_all"] }), "risky");
  assert.equal(foldGhlVerdict({ result: "deliverable", risk: "high" }), "risky");
  assert.equal(foldGhlVerdict({ result: "undeliverable", risk: "high" }), "invalid");
  assert.equal(foldGhlVerdict({ result: "deliverable", leadconnectorRecomendation: { isEmailValid: false } }), "invalid");
});

console.log("\nDrafts");
check("the audit is of the research's pick, else whatever the pages support", () => {
  const facts = { location: "Leeds, UK", case_study_clients: [{ name: "Bright Smiles", town: "York" }] };
  assert.deepEqual(pickSampleTarget("Acme", { ...facts, best_sample: "own" }), { kind: "own", name: "Acme", town: "Leeds" });
  assert.deepEqual(pickSampleTarget("Acme", { ...facts, best_sample: "client" }), { kind: "client", name: "Bright Smiles", town: "York" });
  assert.equal(pickSampleTarget("Acme", { best_sample: "prospect", location: "Leeds" })?.kind, "own");
  assert.equal(pickSampleTarget("Acme", { best_sample: "client", case_study_clients: [{ name: "No Town", town: null }] }), null);
  assert.equal(townOf("Manchester, England, UK"), "Manchester");
  assert.equal(townOf(null), null);
});
check("a draft carries the sample link once, nothing else, and stays short and calm", () => {
  const url = "https://gbp.macaws.ai/s/abc";
  const good = { subject: "a quick audit of bright smiles", body: `Hi Jo,\n\nWe do white-label audits.\n${url}\n\nWorth a look?` };
  assert.deepEqual(draftProblems(good, url), []);
  assert.deepEqual(draftProblems({ ...good, body: good.body.replace(url, `${url}.`) }, url), [], "trailing full stop is fine");
  assert.ok(draftProblems({ ...good, subject: "FREE audit!" }, url).some((p) => p.includes("shouts")));
  assert.ok(draftProblems({ ...good, body: "Hi Jo, no link" }, url).some((p) => p.includes("0 times")));
  assert.ok(draftProblems({ ...good, body: `Hi Jo, an audit: ${url}` }, url).some((p) => p.includes("white-label")));
  assert.ok(draftProblems({ ...good, body: `${good.body} https://other.com` }, url).some((p) => p.includes("other than")));
  assert.ok(draftProblems({ ...good, body: `Hi {{firstName}} ${url}` }, url).some((p) => p.includes("placeholder")));
  assert.ok(draftProblems({ ...good, body: `${url} ${"word ".repeat(140)}` }, url).some((p) => p.includes("words")));
});

console.log("\nSending");
check("a draft becomes safe HTML with its line breaks", () => {
  assert.equal(bodyHtml("Hi Jo,\n\nA & B <c>\r\nhttps://x.io/s/1\n"), "Hi Jo,<br/><br/>A &amp; B &lt;c&gt;<br/>https://x.io/s/1");
});
check("an Instantly event is taken only with our secret", () => {
  assert.equal(webhookSecretOk("s3cret", "s3cret"), true);
  assert.equal(webhookSecretOk("s3cre", "s3cret"), false);
  assert.equal(webhookSecretOk(null, "s3cret"), false);
  assert.equal(webhookSecretOk("anything", undefined), false);
});

console.log(`\n${passed} checks passed`);
