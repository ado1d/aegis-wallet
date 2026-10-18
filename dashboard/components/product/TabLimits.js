"use client";

// Limits — per-token caps, hard-coded into the vault contract by the owner.

import { useState } from "react";
import { apiAuth } from "../auth.js";
import { fmtBase } from "../lib.js";
import { Card, Spinner } from "../ui.js";
import { toast } from "./toast.js";

const DEC = { USDC: 6, ETH: 18 };

export default function TabLimits({ me }) {
  const tokens = me.data?.state?.tokens;
  const [busy, setBusy] = useState(null); // "USDC" | "ETH" while saving
  const [edits, setEdits] = useState({}); // {USDC?: {maxPerTx, dailyLimit}, ETH?: …}

  // current form values: user edits win, otherwise live on-chain defaults
  const cur = (sym) =>
    edits[sym] || {
      maxPerTx: fromBase(tokens?.[sym]?.maxPerTx, DEC[sym]),
      dailyLimit: fromBase(tokens?.[sym]?.dailyLimit, DEC[sym]),
    };

  const save = async (symbol) => {
    if (busy) return;
    const f = cur(symbol);
    const maxPerTx = Number(f.maxPerTx);
    const dailyLimit = Number(f.dailyLimit);
    if (!(maxPerTx > 0) || !(dailyLimit > 0)) {
      toast("Both caps must be positive numbers", { kind: "bad" });
      return;
    }
    if (maxPerTx > dailyLimit) {
      toast("Per-transaction cap can't exceed the daily cap", { kind: "bad" });
      return;
    }
    setBusy(symbol);
    try {
      const r = await apiAuth("/me/policy", { method: "POST", body: { symbol, maxPerTx, dailyLimit } });
      toast("Guardrails updated, enforced on-chain", { hash: r?.result?.hash, explorer: me.data?.vault?.explorer });
      setEdits((x) => ({ ...x, [symbol]: { maxPerTx: String(maxPerTx), dailyLimit: String(dailyLimit) } }));
      me.refresh();
    } catch (e) {
      toast(e?.message || "couldn't update the limits", { kind: "bad" });
    } finally {
      setBusy(null);
    }
  };

  if (!tokens) {
    return (
      <Card><p className="dim"><Spinner /> reading your on-chain limits…</p></Card>
    );
  }

  return (
    <div className="stack">
      <Card title="Spending limits" note="These are hard caps in the contract. The AI cannot exceed them, even if asked.">
        <div className="row2">
          {["USDC", "ETH"].map((sym) => (
            <form
              key={sym}
              className="card"
              style={{ padding: 18 }}
              onSubmit={(e) => { e.preventDefault(); save(sym); }}
              noValidate
            >
              <h3 style={{ marginBottom: 2 }}>{sym === "USDC" ? "💵 USDC, test dollars" : "◆ ETH"}</h3>
              <p className="notegrey" style={{ margin: "0 0 14px" }}>
                balance {fmtBase(tokens[sym]?.vaultBalance, sym)} · spent in 24h {fmtBase(tokens[sym]?.spentInWindow, sym)}
              </p>
              <div className="stack" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor={`max-${sym}`}>Max per transaction</label>
                  <input
                    id={`max-${sym}`} inputMode="decimal"
                    value={cur(sym).maxPerTx}
                    onChange={(e) => setEdits((x) => ({ ...x, [sym]: { ...cur(sym), maxPerTx: e.target.value } }))}
                    disabled={busy === sym}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`daily-${sym}`}>Daily rolling cap (24h)</label>
                  <input
                    id={`daily-${sym}`} inputMode="decimal"
                    value={cur(sym).dailyLimit}
                    onChange={(e) => setEdits((x) => ({ ...x, [sym]: { ...cur(sym), dailyLimit: e.target.value } }))}
                    disabled={busy === sym}
                  />
                </div>
                <div>
                  <button className="btn primary" type="submit" disabled={busy === sym}>
                    {busy === sym ? <Spinner /> : `Save ${sym} limits`}
                  </button>
                </div>
              </div>
            </form>
          ))}
        </div>
      </Card>
      <p className="notegrey">
        Over the per-transaction cap? The request goes to your Approvals queue instead of
        executing. Over the rolling 24-hour cap? It&apos;s refused outright and written to
        the public rejection ledger.
      </p>
    </div>
  );
}

function fromBase(baseStr, decimals) {
  const n = Number(baseStr) / 10 ** decimals;
  return Number.isFinite(n) ? String(n) : "";
}
