"use client";

// Security — kill switch, key export (shown once), sovereign withdrawal, and
// the plain-words key-custody disclosure.

import { useState } from "react";
import { apiAuth } from "../auth.js";
import { Card, Spinner } from "../ui.js";
import { AgentStatusPanel } from "./TabHome.js";
import { copyText, Modal } from "./bits.js";
import { toast } from "./toast.js";

export default function TabSecurity({ me }) {
  return (
    <div className="stack">
      <AgentStatusPanel me={me} />
      <ExportKeyPanel me={me} />
      <WithdrawPanel me={me} />
      <KeyDisclosure />
    </div>
  );
}

/* ── export key ─────────────────────────────────────────────────────────── */

function ExportKeyPanel({ me }) {
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState("primary");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {address, privateKey}
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!password) {
      setError("Enter your account password to unlock the key.");
      return;
    }
    setBusy(true);
    try {
      const r = await apiAuth("/me/export-key", { method: "POST", body: { password, kind } });
      setResult(r);
      setPassword("");
      toast(`${kind} key decrypted; copy it now, it's shown only once`);
    } catch (err) {
      setError(err?.status === 401 ? "Wrong password, try again." : err?.message || "export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Export your keys"
      note="Your keys were generated at signup and are stored encrypted. Export either one; it's your right as the sole custodian."
    >
      {result ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="warnstrip">
            ⚠ This is the only time it&apos;s shown. Store it somewhere safe. With this
            key, anyone can control the account.
          </div>
          <div className="keybox">
            <span className="klabel">address</span>
            <span className="kval">{result.address}</span>
            <span className="klabel">private key</span>
            <span className="kval">{result.privateKey}</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn"
                onClick={async () => { await copyText(result.privateKey); toast("Private key copied"); }}
              >
                ⧉ Copy private key
              </button>
              <button className="btn" onClick={() => setResult(null)}>Done, hide it</button>
            </div>
          </div>
        </div>
      ) : (
        <form className="formgrid" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="exp-pass">Account password</label>
            <input
              id="exp-pass" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              placeholder="••••••••"
            />
          </div>
          <div className="field">
            <label htmlFor="exp-kind">Which key</label>
            <select id="exp-kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}>
              <option value="primary">Primary (vault owner)</option>
              <option value="savings">Savings</option>
            </select>
          </div>
          <div className="span2">
            {error ? <div className="error" style={{ marginBottom: 10 }} role="alert">{error}</div> : null}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? <Spinner /> : "🔓 Decrypt & show once"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/* ── sovereign withdrawal ───────────────────────────────────────────────── */

function WithdrawPanel({ me }) {
  const [symbol, setSymbol] = useState("USDC");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const explorer = me.data?.vault?.explorer;

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      toast("Destination must be a full 0x… address", { kind: "bad" });
      return;
    }
    if (!(Number(amount) > 0)) {
      toast("Amount must be a positive number", { kind: "bad" });
      return;
    }
    setConfirming(true);
  };

  const withdraw = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const r = await apiAuth("/me/withdraw", {
        method: "POST",
        body: { symbol, to: to.trim(), amount: Number(amount) },
      });
      toast(`Withdrawal broadcast: ${amount} ${symbol} to ${to.slice(0, 8)}…`, { hash: r?.result?.hash, explorer });
      setTo(""); setAmount("");
      me.refresh();
    } catch (e) {
      toast(e?.message || "withdrawal failed", { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Withdraw everything"
      note="The owner escape hatch: move any amount out of the vault with your own key; no caps, no whitelist."
    >
      <form className="formgrid" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="wd-sym">Asset</label>
          <select id="wd-sym" value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={busy}>
            <option value="USDC">USDC</option>
            <option value="ETH">ETH</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="wd-amt">Amount</label>
          <input
            id="wd-amt" inputMode="decimal" value={amount}
            onChange={(e) => setAmount(e.target.value)} disabled={busy} placeholder="0.00"
          />
        </div>
        <div className="field span2">
          <label htmlFor="wd-to">Destination address</label>
          <input
            id="wd-to" value={to} onChange={(e) => setTo(e.target.value)} disabled={busy}
            placeholder="0x…" spellCheck={false} style={{ fontFamily: "var(--mono)" }}
          />
        </div>
        <div className="span2">
          <button className="btn danger" type="submit" disabled={busy}>
            {busy ? <Spinner /> : "→ Withdraw"}
          </button>
        </div>
      </form>

      {confirming ? (
        <Modal title="Confirm sovereign withdrawal" danger onClose={() => setConfirming(false)}>
          <div className="m-body">
            You are about to move <b>{amount} {symbol}</b> to{" "}
            <span className="mono">{to}</span>.
            <p style={{ marginTop: 10 }}>
              Sovereign withdrawal bypasses all guardrails; this is your right as
              the vault owner. Double-check the address; on-chain transfers cannot be undone.
            </p>
          </div>
          <div className="m-actions">
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn danger solid" onClick={withdraw}>I understand, withdraw</button>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

/* ── disclosure ─────────────────────────────────────────────────────────── */

function KeyDisclosure() {
  return (
    <Card title="How your keys are held" note="The plain-words version, no fine print.">
      <p className="notegrey" style={{ margin: "0 0 10px" }}>
        Your keys are generated in your browser&apos;s session at signup. Aegis
        staff never see them in plaintext.
      </p>
      <p className="notegrey" style={{ margin: "0 0 10px" }}>
        At rest they exist only as encrypted keystore files, locked with your
        password and a server secret. Plaintext appears in memory solely for
        the seconds it takes to sign your transactions.
      </p>
      <p className="notegrey" style={{ margin: "0 0 10px" }}>
        You can export them anytime from this tab and walk away. The vault is
        yours, not ours.
      </p>
      <p className="notegrey" style={{ margin: 0 }}>
        This is a testnet deployment: the &ldquo;money&rdquo; is play money on
        Sepolia. No real funds, ever.
      </p>
    </Card>
  );
}
