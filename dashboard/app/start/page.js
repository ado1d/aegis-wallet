"use client";

// Onboarding — live view of the provisioning pipeline (one real tx at a time).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation.js";
import { apiAuth, useRequireAuth } from "../../components/auth.js";
import { ProductGate } from "../../components/product/mode.js";
import { usePoll } from "../../components/lib.js";
import { CopyText } from "../../components/product/bits.js";
import { Toasts } from "../../components/product/toast.js";

const STATE_INDEX = {
  pending: 0,
  stipend: 0,
  deploying: 1,
  configuring: 2,
  transferring: 3,
  seeding: 4,
  done: 5,
};

function StartInner() {
  const router = useRouter();
  const { ready, authed } = useRequireAuth();
  const [chain, setChain] = useState("Sepolia");
  const [meErr, setMeErr] = useState(null);
  const [halt, setHalt] = useState(false); // stop polling once terminal

  const provision = usePoll(() => apiAuth("/me/provision"), 2000, !halt);
  const vault = provision.data?.vault || {};
  const state = vault.state || "pending";

  useEffect(() => {
    if ((state === "done" || state === "error") && !halt) setHalt(true);
  }, [state, halt]);

  // one-shot /me for the friendly chain name
  useEffect(() => {
    if (!authed) return;
    apiAuth("/me")
      .then((me) => {
        if (me?.vault?.chain) setChain(capitalize(me.vault.chain));
      })
      .catch((e) => setMeErr(e?.message || null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  if (!ready || !authed) {
    return (
      <div className="ob-page">
        <p className="faint">checking your session…</p>
      </div>
    );
  }

  const steps = [
    { t: "Creating your account", d: "Generating your keys and reserving your vault." },
    { t: `Deploying your vault on ${chain}`, d: "A real contract, deployed just for you." },
    { t: "Configuring your guardrails", d: "Caps, swap venue and your savings payee." },
    { t: "Handing you the keys", d: "Ownership moves to your key; only you can change the rules." },
    { t: "Topping up test dollars", d: "Funding your vault with play money." },
    { t: "Ready", d: "Your vault is live. Time to meet Aegis." },
  ];
  const active = STATE_INDEX[state] ?? 0;

  return (
    <div className="ob-page">
      <span className="wordmark">
        <span className="glyph">🛡</span>
        <span className="name">Aegis<i className="dot">.</i></span>
      </span>

      {state === "error" ? (
        <div className="card ob-card ob-error" role="alert">
          <h2>Something went wrong</h2>
          <p className="lede">Provisioning stopped before your vault was ready.</p>
          <div className="error" style={{ marginBottom: 12 }}>
            {vault.error || "unknown error"}
          </div>
          <p className="notegrey" style={{ marginBottom: 14 }}>
            This is usually a temporary network issue on the testnet. Reload this
            page to retry; every step is idempotent and picks up where it left off.
          </p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Retry provisioning
          </button>
        </div>
      ) : state === "done" ? (
        <div className="card ob-card" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <h2>Your vault is live</h2>
          <p className="lede" style={{ marginBottom: 16 }}>
            Deployed on {chain}, owned by your key, funded with test dollars.
          </p>
          {vault.address ? (
            <div style={{ marginBottom: 18, display: "flex", justifyContent: "center" }}>
              <CopyText text={vault.address} display={`${vault.address.slice(0, 10)}…${vault.address.slice(-8)}`} />
            </div>
          ) : null}
          <button className="btn primary" style={{ fontSize: 14, padding: "12px 26px" }} onClick={() => router.push("/app")}>
            Open Aegis →
          </button>
        </div>
      ) : (
        <div className="card ob-card">
          <h2>Setting up your vault</h2>
          <p className="lede">
            Real transactions, one at a time; this takes a minute or two on {chain}.
            You can keep this page open; it updates live.
          </p>

          <div className="ob-steps" role="list">
            {steps.map((s, i) => {
              const done = i < active;
              const isActive = i === active;
              return (
                <div className={`ob-step ${done ? "done" : ""} ${isActive ? "active" : ""}`} key={s.t} role="listitem">
                  <div className="marker" aria-hidden="true">
                    {done ? "✓" : isActive ? <span className="ob-dots"><i /><i /><i /></span> : i + 1}
                  </div>
                  <div>
                    <div className="t">{s.t}</div>
                    <div className="d">{s.d}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {vault.address ? (
            <div className="ob-addr">
              <div className="k" style={{ color: "var(--faint)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>
                your vault address
              </div>
              <CopyText text={vault.address} display={vault.address} />
            </div>
          ) : (
            <p className="notegrey" style={{ marginTop: 10 }}>
              Your vault address will appear here as soon as the contract is deployed.
            </p>
          )}

          {provision.error ? (
            <div className="error" style={{ marginTop: 12 }}>{provision.error}</div>
          ) : meErr ? (
            <div className="error" style={{ marginTop: 12 }}>{meErr}</div>
          ) : null}
        </div>
      )}
      <Toasts />
    </div>
  );
}

function capitalize(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

export default function StartPage() {
  return (
    <ProductGate>
      <StartInner />
    </ProductGate>
  );
}
