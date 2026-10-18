import "./globals.css";

export const metadata = {
  title: "Aegis Wallet Dashboard",
  description:
    "AI as a Financial Participant: a guarded autonomous wallet. Natural language in, policy-checked on-chain action out.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
