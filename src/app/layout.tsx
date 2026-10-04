export const metadata = {
  title: "GBP Autopilot sales bot",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#fafafa", color: "#14151a" }}>
        {children}
      </body>
    </html>
  );
}
