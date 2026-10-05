"use client";

import { useState } from "react";

/** One tap: the message goes on the clipboard and their chat (or dialler) opens. */
export function CopyOpen({ message, href, label }: { message: string; href: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <a
      href={href}
      target={href.startsWith("tel:") ? undefined : "_blank"}
      rel="noreferrer"
      onClick={() => {
        navigator.clipboard?.writeText(message).then(() => setCopied(true), () => {});
      }}
      style={{
        display: "inline-block",
        background: "#1d4ed8",
        color: "#fff",
        padding: "10px 14px",
        borderRadius: 8,
        textDecoration: "none",
        fontWeight: 600,
      }}
    >
      {copied ? "Copied — paste & send" : label}
    </a>
  );
}
