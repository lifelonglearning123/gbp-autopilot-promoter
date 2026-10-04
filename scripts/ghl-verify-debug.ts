/** Can our GHL token use GHL's email verification? Prints status and response shape, never the address. */
import { env } from "../src/env";

async function main() {
  const res = await fetch(`https://services.leadconnectorhq.com/email/verify?locationId=${env.ghl_location}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ghl_token}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ type: "email", verify: "postmaster@gmail.com" }),
  });
  const text = await res.text();
  console.log("HTTP", res.status);
  console.log(text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>").slice(0, 800));
}
main();
