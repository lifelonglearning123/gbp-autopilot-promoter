/**
 * Pins the pure rules, with no database, network or keys. Run: npm run verify
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { agencyKey, domainOf, emailType, looksLikeAgency, pickSiteEmail, tidyEmail } from "../src/lib/contact-rules";
import { signedByPlatform } from "../src/lib/platform";
import { countryFromLocation, ghlTraces, internalLinks, logoCandidates, pageText, pickPages, publishedEmails, themeColour } from "../src/lib/crawl-rules";
import { AGENCY_PRICE, forMarket, marketOf } from "../src/lib/offer";
import { bodyHtml, foldVerdict, webhookSecretOk } from "../src/lib/instantly";
import { foldGhlVerdict, TAG_NOT_VERIFIED, TAG_VERIFIED, verificationTag } from "../src/lib/ghl";
import { actionLink, signatureOk } from "../src/lib/links";
import { followUpProblems, templateFollowUps } from "../src/lib/draft-rules";
import { emailsIn, instagramHandle, messageLink, phonesIn, sortLinks, tiktokHandle, tiktokProfile } from "../src/lib/creator-rules";
import { sequenceSteps } from "../src/lib/instantly";
import { countryOf, draftProblems, partnerProblems, pickSampleTarget, sameBusiness, sampleTargets, townOf } from "../src/lib/draft-rules";

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

check("a HighLevel site is kept when it reads like a marketing agency", () => {
  assert.equal(looksLikeAgency("Norwich Digital Marketing Agency | Smash Marketing"), true);
  assert.equal(looksLikeAgency("Web Design Croydon | Smart Cow"), true);
  assert.equal(looksLikeAgency("Trusted Recruitment Agency UK"), false);
  assert.equal(looksLikeAgency("Estate & Letting Agents in Bushey"), false);
  assert.equal(looksLikeAgency("Wight Tyres - Leading Tyre Specialists"), false);
  assert.equal(looksLikeAgency("Seoul food"), false, "a word inside another word does not count");
});
check("the address taken from an agency's site: a person, else a shared inbox, never another company's", () => {
  assert.equal(pickSiteEmail(["info@acme.co.uk", "jo@acme.co.uk"], "acme.co.uk"), "jo@acme.co.uk");
  assert.equal(pickSiteEmail(["hello@acme.co.uk", "noreply@acme.co.uk"], "acme.co.uk"), "hello@acme.co.uk");
  assert.equal(pickSiteEmail(["jo@mail.acme.co.uk"], "acme.co.uk"), "jo@mail.acme.co.uk");
  assert.equal(pickSiteEmail(["support@wix.com", "info@client-dentist.co.uk"], "acme.co.uk"), null);
  assert.equal(pickSiteEmail(["acmeseo@gmail.com"], "acme.co.uk"), null, "free-mail is usually a sole trader (PECR)");
  assert.equal(pickSiteEmail(["privacy@acme.co.uk"], "acme.co.uk"), null);
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

check("with no town to go on, the agency is looked up on Google by name (and country)", () => {
  assert.deepEqual(sampleTargets("Acme", { best_sample: "own", location: null }, "US"), [{ kind: "own", name: "Acme", town: "US" }]);
  assert.deepEqual(sampleTargets("Acme", { best_sample: "own", location: "Leeds, UK" }), [
    { kind: "own", name: "Acme", town: "Leeds" },
    { kind: "own", name: "Acme", town: "UK" },
  ]);
  assert.equal(sampleTargets("Acme", { best_sample: "client", case_study_clients: [{ name: "Bob's", town: "York" }] })[0].kind, "client");
  assert.equal(countryOf("Austin, Texas, USA"), "USA");
  assert.equal(countryOf("Austin"), null);
});
check("an audit of a different business than asked for is caught", () => {
  assert.equal(sameBusiness("Digital Marketing Inc.", "Digital"), false);
  assert.equal(sameBusiness("PearPixels LLC", "Pearpixels LLC"), true);
  assert.equal(sameBusiness("Pixel Agility", "Pixel Agility, LLC"), true);
  assert.equal(sameBusiness("Elaunchers", "eLaunchers"), true);
  assert.equal(sameBusiness("Pear Pixels", "PearPixels"), true);
  assert.equal(sameBusiness("Saltz Plastic Surgery", "Saltz Plastic Surgery & Saltz Spa Vitoria"), true);
  assert.equal(sameBusiness("Acme Roofing", "Best Roofing"), false);
});

console.log("\nSending");
check("a draft becomes safe HTML with its line breaks", () => {
  assert.equal(bodyHtml("Hi Jo,\n\nA & B <c>\r\nhttps://x.io/s/1\n"), "<div>Hi Jo,</div><div><br /></div><div>A &amp; B &lt;c&gt;</div><div>https://x.io/s/1</div>");
});
check("an Instantly event is taken only with our secret", () => {
  assert.equal(webhookSecretOk("s3cret", "s3cret"), true);
  assert.equal(webhookSecretOk("s3cre", "s3cret"), false);
  assert.equal(webhookSecretOk(null, "s3cret"), false);
  assert.equal(webhookSecretOk("anything", undefined), false);
});

console.log("\nFollow-ups");
check("follow-ups: short, only our links, step 3 carries the claim link", () => {
  const p = "https://gbp.macaws.ai/preview/x";
  const c = "https://gbp.macaws.ai/claim/y";
  const good = { body_2: `Hi Jo,\n\nOne more thing.\n${p}\n\nWorth a look?`, body_3: `Hi Jo,\n\nHow it works.\n${c}\n\nFit?`, body_4: "Hi Jo, I'll leave it here." };
  assert.deepEqual(followUpProblems(good, p, c), []);
  assert.ok(followUpProblems({ ...good, body_3: `Hi Jo ${p}` }, p, c).some((x) => x.includes("claim link")));
  assert.ok(followUpProblems({ ...good, body_2: "see https://evil.com" }, p, c).some((x) => x.includes("not the audit")));
  assert.ok(followUpProblems({ ...good, body_4: "" }, p, c).some((x) => x.includes("empty")));
  assert.ok(followUpProblems({ ...good, body_4: "word ".repeat(70) }, p, c).some((x) => x.includes("words")));
  assert.deepEqual(followUpProblems({ ...good, body_3: `Hi ${p}` }, p, null), [], "no claim link: the audit link will do");
});
check("the template follow-ups pass the same rules", () => {
  const p = "https://gbp.macaws.ai/preview/x";
  const t = templateFollowUps({ firstName: "Jo", finding: "No new reviews in 90 days.", previewUrl: p, claimUrl: "https://gbp.macaws.ai/claim/y" });
  assert.deepEqual(followUpProblems(t, p, "https://gbp.macaws.ai/claim/y"), []);
  assert.deepEqual(followUpProblems(templateFollowUps({ firstName: null, finding: null, previewUrl: p, claimUrl: null }), p, null), []);
});
check("the sequence runs day 0, 3, 7, 14, follow-ups in the same thread", () => {
  const steps = sequenceSteps("Chao", "Legal");
  assert.deepEqual(steps.map((s) => s.delay), [3, 4, 7, 0]);
  assert.deepEqual(steps.map((s) => s.variants[0].subject), ["{{subject}}", "", "", ""]);
  assert.ok(steps[2].variants[0].body.includes("{{body_3_html}}"));
});

console.log("\nYouTube creators");
check("a creator sequence states the offer plainly and links only the claim link and the audit", () => {
  const links = { claimUrl: "https://gbp.macaws.ai/c/abc", previewUrl: "https://gbp.macaws.ai/s/abc" };
  const good = {
    subject: "your own branded version",
    body: [
      "Hi Sam,",
      "Your video on getting more reviews fits this well. You can have your own white-label Google Business Profile service, in your brand, at no cost.",
      "Businesses pay £49 a month and you earn 40% of what each pays, for life. Your listing scored 62:",
      links.previewUrl,
      "Set yours up here:",
      links.claimUrl,
      "Worth a look?",
    ].join("\n\n"),
    body_2: "Hi Sam, would your viewers use this? Easy to show on screen.",
    body_3: `Hi Sam, about £19.60 a month for each business that stays.\n\n${links.claimUrl}\n\nWant it?`,
    body_4: "Hi Sam, I'll stop here. The offer stands if you reply later.",
  };
  assert.deepEqual(partnerProblems(good, links), []);
  assert.deepEqual(partnerProblems({ ...good, body: good.body.replace(`${links.previewUrl}\n\n`, "") }, { ...links, previewUrl: null }), []);
  assert.ok(partnerProblems({ ...good, body: good.body.replace("40%", "a share") }, links).some((p) => p.includes("40%")));
  assert.ok(partnerProblems({ ...good, body: good.body.replace(", for life", "") }, links).some((p) => p.includes("for life")));
  assert.ok(partnerProblems({ ...good, body: good.body.replace(", at no cost", "") }, links).some((p) => p.includes("costs them nothing")));
  assert.ok(partnerProblems({ ...good, body_2: `${good.body_2} https://local.macaws.ai` }, links).some((p) => p.includes("not the claim link")));
  assert.ok(partnerProblems({ ...good, body: good.body.replace(links.claimUrl, "") }, links).some((p) => p.includes("claim link appears 0")));
  assert.ok(partnerProblems({ ...good, body_3: "Hi Sam, still keen?" }, links).some((p) => p.includes("body_3")));
  assert.ok(partnerProblems({ ...good, subject: "EARN NOW!" }, links).some((p) => p.includes("shouts")));
});
check("a TikTok handle comes from a profile or video link, nothing else", () => {
  assert.equal(tiktokHandle("https://www.tiktok.com/@Jo.Smith/video/7312?lang=en"), "jo.smith");
  assert.equal(tiktokHandle("https://tiktok.com/@local_seo_tips"), "local_seo_tips");
  assert.equal(tiktokHandle("https://www.tiktok.com/tag/localseo"), null);
  assert.equal(tiktokHandle("https://example.com/@jo"), null);
});
check("a TikTok profile page gives its bio, bio link, avatar and counts; a challenge page gives null", () => {
  const data = {
    __DEFAULT_SCOPE__: {
      "webapp.user-detail": {
        userInfo: {
          user: { uniqueId: "jo", nickname: "Jo | Local SEO", signature: "Reviews tips 📍UK\njo@joseo.co.uk", bioLink: { link: "https://linktr.ee/jo" }, avatarLarger: "https://p16.tiktokcdn.com/a.jpeg" },
          stats: { followerCount: 12000, videoCount: 240 },
        },
      },
    },
  };
  const page = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></html>`;
  assert.deepEqual(tiktokProfile(page), {
    nickname: "Jo | Local SEO",
    bio: "Reviews tips 📍UK\njo@joseo.co.uk",
    bioLink: "https://linktr.ee/jo",
    avatar: "https://p16.tiktokcdn.com/a.jpeg",
    followers: 12000,
    videos: 240,
  });
  assert.equal(tiktokProfile("<html>Please wait...</html>"), null);
  assert.equal(tiktokProfile(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{}}</script>`), null);
});
check("a channel description's links are sorted by network; affiliate links are not their site", () => {
  const d = `My agency: https://www.acme-local.com\nIG https://instagram.com/acme.local/ \nJoin https://www.skool.com/gbp-pros\nTry HighLevel free: https://www.gohighlevel.com/?fp_ref=acme\nbook https://calendly.com/acme/15min`;
  const l = sortLinks(d);
  assert.equal(l.website, "https://www.acme-local.com");
  assert.equal(l.instagram, "https://instagram.com/acme.local/");
  assert.equal(l.skool, "https://www.skool.com/gbp-pros");
  assert.equal(l.calendar, "https://calendly.com/acme/15min");
  assert.ok(!Object.values(l).some((u) => u.includes("gohighlevel")), "an affiliate link is not their website");
});
check("emails and phone numbers are read from text; prices and dates are not phones", () => {
  assert.deepEqual(emailsIn("Business inquiries: Jo@Acme-Local.com or logo@2x.png"), ["jo@acme-local.com"]);
  assert.deepEqual(phonesIn("Call us: (555) 123-4567"), ["(555) 123-4567"]);
  assert.deepEqual(phonesIn("WhatsApp +44 7700 900123"), ["+44 7700 900123"]);
  assert.deepEqual(phonesIn("Only $1,497 until 2026-10-05, 30000 views"), []);
});
check("the tap-to-message link for each network", () => {
  assert.equal(instagramHandle("https://www.instagram.com/jo.local/?hl=en"), "jo.local");
  assert.equal(instagramHandle("https://www.instagram.com/p/abc123/"), null);
  assert.equal(messageLink("instagram", "https://instagram.com/jo.local"), "https://ig.me/m/jo.local");
  assert.equal(messageLink("phone", "+44 7700 900123"), "tel:+447700900123");
});

check("GHL tag: verified is 'email verified'; catch-all and invalid are 'email not verified'; no answer, no tag", () => {
  assert.equal(verificationTag("valid"), TAG_VERIFIED);
  assert.equal(verificationTag("risky"), TAG_NOT_VERIFIED);
  assert.equal(verificationTag("invalid"), TAG_NOT_VERIFIED);
  assert.equal(verificationTag("pending"), null);
  assert.equal(verificationTag("unverified"), null);
  assert.equal(TAG_VERIFIED, "email verified");
  assert.equal(TAG_NOT_VERIFIED, "email not verified");
  assert.equal(foldVerdict({ verification_status: "verified", catch_all: true }), "risky", "catch-all is not verified");
});

console.log("\nMarkets");
check("GoHighLevel is seen in page code: its widgets, link domain and booking pages", () => {
  assert.deepEqual(ghlTraces('<script src="https://widgets.leadconnectorhq.com/loader.js"></script>'), ["LeadConnector widget or form"]);
  assert.deepEqual(ghlTraces('<a href="https://visible.ghostengine.digital/widget/booking/abc">Book</a>'), ["GoHighLevel booking or form page"]);
  assert.deepEqual(ghlTraces('<a href="https://link.msgsndr.com/x">'), ["GoHighLevel link domain (msgsndr)"]);
  assert.deepEqual(ghlTraces("<p>We build websites</p>"), []);
});
check("an agency's country comes from where its site says it is", () => {
  assert.equal(countryFromLocation("Ocala, FL, USA"), "US");
  assert.equal(countryFromLocation("Inland Empire, California, USA"), "US");
  assert.equal(countryFromLocation("West Palm Beach, Florida"), "US");
  assert.equal(countryFromLocation("Austin, TX"), "US");
  assert.equal(countryFromLocation("Norwich, UK"), "GB");
  assert.equal(countryFromLocation("Leeds, England"), "GB");
  assert.equal(countryFromLocation("Toronto, ON, Canada"), "CA");
  assert.equal(countryFromLocation("Dublin, Ireland"), "IE");
  assert.equal(countryFromLocation(null), null);
  assert.equal(countryFromLocation("Remote"), null);
});
check("US agencies get $199 a month and US English; everyone else £149 and UK English", () => {
  assert.equal(marketOf("US"), "US");
  assert.equal(marketOf("GB"), "UK");
  assert.equal(marketOf(null), "UK");
  assert.equal(forMarket("From £149 a month. Plain text, UK English.", "US"), "From $199 a month. Plain text, US English.");
  assert.equal(forMarket("From £149 a month.", "UK"), "From £149 a month.");
  const t = templateFollowUps({ firstName: "Jo", finding: null, previewUrl: "https://gbp.macaws.ai/preview/x", claimUrl: null, price: AGENCY_PRICE.US });
  assert.match(t.body_3, /From \$199 a month/);
  assert.doesNotMatch(t.body_3, /£/);
});

console.log("\nOwner's links");
check("a stop / pause link works only with its own signature", () => {
  process.env.ACTION_SECRET = "test-secret";
  process.env.APP_URL = "https://x.io";
  const url = new URL(actionLink("stop", "abc"));
  const s = url.searchParams.get("s");
  assert.equal(signatureOk("stop", "abc", s), true);
  assert.equal(signatureOk("stop", "abd", s), false, "another draft");
  assert.equal(signatureOk("pause", "abc", s), false, "another action");
  assert.equal(signatureOk("delete", "abc", s), false, "not an action");
  assert.equal(signatureOk("stop", "abc", null), false);
});

console.log(`\n${passed} checks passed`);
