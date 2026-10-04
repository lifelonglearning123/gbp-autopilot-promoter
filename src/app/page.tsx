import { env } from "@/env";

export const dynamic = "force-dynamic";

/**
 * A plain status page: which parts are connected. Says yes/no only — never a
 * key, a count of contacts, or a name. The dashboard comes later.
 */
export default function Home() {
  const parts: [string, boolean][] = [
    ["Database (Neon)", !!env.DATABASE_URL],
    ["GoHighLevel", !!(env.ghl_token && env.ghl_location)],
    ["GBP Autopilot platform key", !!env.PLATFORM_BOT_API_KEY],
    ["Platform events secret", !!env.PLATFORM_WEBHOOK_SECRET],
    ["OpenRouter", !!env.OPENROUTER_API_KEY],
    ["Instantly", !!env.INSTANTLY_API_KEY],
    ["Trigger.dev", !!env.TRIGGER_SECRET_KEY],
  ];
  return (
    <main style={{ maxWidth: 560, margin: "64px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 24 }}>GBP Autopilot sales bot</h1>
      <p style={{ color: "#5b5f6b" }}>Set-up status.</p>
      <ul style={{ listStyle: "none", padding: 0, lineHeight: 2 }}>
        {parts.map(([name, ok]) => (
          <li key={name}>
            <span style={{ color: ok ? "#13804a" : "#b42318", fontWeight: 600 }}>{ok ? "Connected" : "Not set"}</span>
            {" — "}
            {name}
          </li>
        ))}
      </ul>
    </main>
  );
}
