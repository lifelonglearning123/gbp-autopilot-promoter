import { env } from "@/env";

/**
 * GoHighLevel v2: reading the agency list. Keys come from the environment
 * (ghl_token, ghl_location) and are never logged.
 */

const BASE = "https://services.leadconnectorhq.com";

export type GhlContact = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  companyName?: string | null;
  website?: string | null;
  country?: string | null;
  source?: string | null;
  dnd?: boolean | null;
  validEmail?: boolean | null;
  tags?: string[];
};

function headers() {
  if (!env.ghl_token || !env.ghl_location) throw new Error("ghl_token and ghl_location must be set in .env.local.");
  return {
    Authorization: `Bearer ${env.ghl_token}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** Every contact carrying `tag`, 100 at a time. */
export async function contactsTagged(tag: string): Promise<GhlContact[]> {
  const all: GhlContact[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${BASE}/contacts/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        locationId: env.ghl_location,
        page,
        pageLimit: 100,
        filters: [{ field: "tags", operator: "contains", value: [tag] }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GHL contacts/search answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { contacts?: GhlContact[] };
    const batch = data.contacts ?? [];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
