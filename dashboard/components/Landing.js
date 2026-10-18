"use client";

// Product-mode marketing landing ("/" when NEXT_PUBLIC_AEGIS_MODE=product).
// Pure client component, no data fetching except the one-click demo login.

import { useState } from "react";
import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import { api } from "./lib.js";
import { setAuth, routeAfterLogin } from "./auth.js";
import { Toasts, toast } from "./product/toast.js";

export default function Landing() {
  const router = useRouter();
  const [demoBusy, setDemoBusy] = useState(false);

  const tryDemo = async () => {
    if (demoBusy) return;
    setDemoBusy(true);
    try {
      const r = await api("/auth/demo", { method: "POST" });
      setAuth(r.token, r.user);
      await routeAfterLogin(router); // /app when the demo vault is ready, /start otherwise
    } catch (e) {
      toast(
        e?.status === 404
          ? "Demo account isn't seeded on this deployment yet"
          : e?.message || "couldn't reach the demo",
        { kind: "bad" }
      );
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className="lp-page">
      <header className="lp-header">
        <span className="wordmark">
          <span className="glyph">🛡</span>
          <span className="name">Aegis<i className="dot">.</i></span>
        </span>
        <nav aria-label="main">
          <Link className="link" href="/login">Log in</Link>
          <Link className="btn primary" href="/signup">Create account</Link>
        </nav>
      </header>

      <main className="lp-main">
        <section className="lp-hero">
          <div className="badge-line">
            <span className="dotok" /> Sepolia testnet · play money, zero risk
          </div>
          <h1 className="lp-h1">
            Your money. Your rules. <em>Enforced by code.</em>
          </h1>
          <p className="lp-sub">
            Aegis is an AI agent that moves money for you, but only inside the
            guardrails you set on-chain. Every refusal is written to a public ledger.
          </p>
          <div className="lp-ctas">
            <Link className="btn primary" href="/signup">Create your account</Link>
            <button className="btn" onClick={tryDemo} disabled={demoBusy}>
              {demoBusy ? "Opening the demo…" : "Try the live demo"}
            </button>
          </div>
        </section>

        <section className="lp-section" aria-label="features">
          <h2>Built for the age of AI agents</h2>
          <p className="lede">Convenience of an assistant, safety of a smart contract.</p>
          <div className="lp-features">
            <div className="lp-feature">
              <div className="glyph">💬</div>
              <h3>Talk to your wallet</h3>
              <p>
                Pay rent, sweep savings, swap for ETH or just ask what you&apos;ve
                spent, in plain language. Aegis turns sentences into signed,
                checked transactions.
              </p>
            </div>
            <div className="lp-feature">
              <div className="glyph">⚖️</div>
              <h3>Guardrails on-chain</h3>
              <p>
                Per-transaction and rolling-24-hour caps, a payee whitelist and a
                kill switch, enforced by the vault contract, not by the AI&apos;s
                good behavior.
              </p>
            </div>
            <div className="lp-feature">
              <div className="glyph">🔑</div>
              <h3>You hold the keys</h3>
              <p>
                Your vault, your key: export it anytime. The agent is only a
                bounded operator that can never outvote the contract.
              </p>
            </div>
          </div>
        </section>

        <section className="lp-section" aria-label="how it works">
          <h2>How it works</h2>
          <p className="lede">From signup to your first command.</p>
          <div className="lp-how">
            <div className="step-card">
              <div className="num">1</div>
              <h3>Sign up</h3>
              <p>Email and password. We generate your keys on the spot; they never leave your control.</p>
            </div>
            <div className="step-card">
              <div className="num">2</div>
              <h3>We deploy YOUR vault</h3>
              <p>A personal AegisVault is deployed on Sepolia with your rules baked in (~2 minutes).</p>
            </div>
            <div className="step-card">
              <div className="num">3</div>
              <h3>Chat</h3>
              <p>Tell Aegis what you need. Watch it act, or refuse on the record, when a rule would break.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        Aegis Wallet · 2026 Shenzhen International FinTech Competition · built on
        Sepolia, no real funds, ever.
      </footer>
      <Toasts />
    </div>
  );
}
