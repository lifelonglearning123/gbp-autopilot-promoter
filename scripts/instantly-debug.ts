/** What does Instantly say to one verification? Prints status and body keys, never the address. */
import { env } from "../src/env";

async function main() {
  const res = await fetch("https://api.instantly.ai/api/v2/email-verification", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "postmaster@gmail.com" }),
  });
  const text = await res.text();
  console.log("HTTP", res.status);
  console.log(text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>").slice(0, 600));
}
main();
