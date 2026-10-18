"use client";

import { useState, useEffect } from "react";
import { api, fmtBase } from "./lib.js";
import { Card, Bar, Empty, ErrorNote, Spinner } from "./ui.js";

// Portfolio: per-token autonomy envelope + the guarded swap quote widget.
export default function TabPortfolio({ state }) {
  const [amount, setAmount] = useState("200");
  const [sell, setSell] = useState("USDC");
  const [buy, setBuy] = useState("ETH");
  const [quote, setQuote] = useState(null);
  const [qErr, setQErr] = useState(null);
  const [qBusy, setQBusy] = useState(false);

  const fetchQuote = async () => {
    const a = Number(amount);
    if (!(a > 0)) { setQuote(null); setQErr("amount must be > 0"); return; }
    setQBusy(true);
    setQErr(null);
    try {
      setQuote(await api(`/quote?sell=${sell}&buy=${buy}&amount=${a}`));
    } catch (e) {
      setQuote(null);
      setQErr(e.message);
    } finally {
      setQBusy(false);
    }
  };

  useEffect(() => { fetchQuote(); /* initial quote */ /* eslint-disable-next-line */ }, []);

  if (!state) {
    return <Card><p style={{ color: "var(--dim)" }}><Spinner /> loading portfolio…</p></Card>;
  }

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid two">
        {["USDC", "ETH"].map((sym) => {
          const t = state.tokens?.[sym];
          if (!t) return null;
          return (
            <Card
              key={sym}
              title={`${sym}: autonomy envelope`}
              note="Enforced on-chain by AegisVault; the agent cannot exceed it."
            >
              <div className="rowlist">
                <div className="row">
                  <div className="grow">
                    <div className="title">Vault balance</div>
                    <div className="meta">{fmtBase(t.vaultBalance, sym)} {sym}</div>
                  </div>
                </div>
                <div className="row">
                  <div className="grow">
                    <div className="title">Rolling 24h window</div>
                    <Bar value={t.spentInWindow} max={t.dailyLimit} limitHuman={`${fmtBase(t.dailyLimit, sym)} ${sym}`} />
                    <div className="meta">
                      spent {fmtBase(t.spentInWindow, sym)} {sym} · ring buffer {t.liveEntries}/64 entries
                    </div>
                  </div>
                </div>
                <div className="row">
                  <div className="grow">
                    <div className="title">Per-transaction cap</div>
                    <div className="meta">
                      {fmtBase(t.maxPerTx, sym)} {sym}; over this, the human co-signs
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card
        title="Swap quote (guarded venue)"
        note="Reads the on-chain MockSwap rate. minOut = expected − slippage guard; the vault enforces it atomically."
      >
        <div className="formrow">
          <input style={{ width: 110 }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="amount" />
          <select className="btn" value={sell} onChange={(e) => setSell(e.target.value)} style={{ padding: "7px 10px" }}>
            <option>USDC</option>
            <option>ETH</option>
          </select>
          <span style={{ color: "var(--faint)", alignSelf: "center" }}>→</span>
          <select className="btn" value={buy} onChange={(e) => setBuy(e.target.value)} style={{ padding: "7px 10px" }}>
            <option>ETH</option>
            <option>USDC</option>
          </select>
          <button className="btn primary" onClick={fetchQuote} disabled={qBusy}>
            {qBusy ? <Spinner /> : "Quote"}
          </button>
        </div>
        <ErrorNote>{qErr}</ErrorNote>
        {quote ? (
          <div className="kv">
            <div className="item">
              <div className="k">Expected out</div>
              <div className="v">{quote.expectedOutHuman} {quote.buySymbol}</div>
            </div>
            <div className="item">
              <div className="k">Minimum out (enforced)</div>
              <div className="v">{quote.minOutHuman} {quote.buySymbol}</div>
            </div>
            <div className="item">
              <div className="k">Slippage guard</div>
              <div className="v">{quote.slippageBps / 100}%</div>
            </div>
            <div className="item">
              <div className="k">Sell side counts</div>
              <div className="v">against the same rolling window; no swap loophole</div>
            </div>
          </div>
        ) : !qErr ? (
          <Empty>set an amount and press Quote</Empty>
        ) : null}
      </Card>
    </div>
  );
}
