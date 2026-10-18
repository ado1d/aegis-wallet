import "./globals.css";

export const metadata = {
  metadataBase: new URL("https://aegis-dashboard-rosy.vercel.app"),
  title: "aegisAiWallet",
  description:
    "An AI agent that moves money for you, only inside the guardrails you set on-chain. Sepolia testnet.",
};

export const viewport = {
  themeColor: "#0c0a16",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
