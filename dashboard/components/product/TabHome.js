"use client";

// Home — balances vs. caps, agent status, accounts, quick actions, faucet.

import { useState } from "react";
import { apiAuth } from "../auth.js";
import { fmtBase } from "../lib.js";
import { Card, Spinner } from "../ui.js";
import { AddressQr, AgentChip, CapMeter, CopyText, TxLink } from "./bits.js";
import ConnectWallet from "./ConnectWallet.js";
import { toast } from "./toast.js";

export default function TabHome({ me, onRun }) {
  const data = me.data;
  const state = data?.state;
  const vault = data?.vault || {};
  const explorer = vault.explorer;
  const [faucetBusy, setFaucetBusy] = useState(false);

  const usdc = state?.tokens?.USDC;
  const eth = state?.tokens?.ETH;

  const topUp = async () => {
    if (faucetBusy) return;
    setFaucetBusy(true);
    try {
      const r = await apiAuth("/me/faucet", { method: "POST" });
      toast(`Topped up ${Number(r.amount).toLocaleString()} test USDC`, { hash: r.txHash, explorer });
      me.refresh();
    } catch (e) {
      toast(e?.message || "faucet unavailable", { kind: "bad" });
    } finally {
      setFaucetBusy(false);
    }
  };

  if (!data) {
    return (
      <Card><p className="dim" style={{ display: "flex", gap: 10, alignItems: "center" }}><Spinner /> loading your wallet…</p></Card>
    );
  }

  return (
    <div className="stack">
      <div className="balgrid">
        <div className="card balcard">
          <div className="sym">💵 USDC · test dollars</div>
          <div className="amt">
            {usdc ? fmtBase(usdc.vaultBalance, "USDC") : "–"}<small>USDC</small>
          </div>
          {usdc ? (
            <CapMeter spent={usdc.spentInWindow} limit={usdc.dailyLimit} symbol="USDC" fmt={fmtBase} />
          ) : (
            <p className="notegrey mb0">caps appear once your vault is live</p>
          )}
          <div style={{ marginTop: 14 }}>
            <button className="btn" onClick={topUp} disabled={faucetBusy}>
              {faucetBusy ? <Spinner /> : "＋ Top up test dollars"}
            </button>
          </div>
        </div>
        <div className="card balcard">
          <div className="sym">◆ ETH · for gas & swaps</div>
          <div className="amt">
            {eth ? fmtBase(eth.vaultBalance, "ETH") : "–"}<small>ETH</small>
          </div>
          {eth ? (
            <CapMeter spent={eth.spentInWindow} limit={eth.dailyLimit} symbol="ETH" fmt={fmtBase} />
          ) : (
            <p className="notegrey mb0">caps appear once your vault is live</p>
          )}
        </div>
      </div>

      <AgentStatusPanel me={me} />

      <WalletAccounts me={me} />

      <ConnectWallet me={me} />

      <Card title="Quick actions" note="One tap sends it to the console, where you can watch the decision unfold.">
        <div className="qa-row">
          <button className="btn" onClick={() => onRun("Move 100 dollars to my savings wallet")}>
            → Move 100 to savings
          </button>
          <button className="btn" onClick={() => onRun("Swap 50 dollars to ETH")}>
            ⇄ Swap 50 USDC→ETH
          </button>
          <button className="btn" onClick={() => onRun("How much can I spend today?")}>
            ? How much can I spend today?
          </button>
        </div>
      </Card>
    </div>
  );
}

/** Every wallet the user owns + live balances — vault, primary, savings.
 *  Money moved "to savings" leaves the vault and lands on the savings
 *  address; before this card existed that money was invisible. */
function WalletAccounts({ me }) {
  const data = me.data;
  const vault = data?.vault || {};
  const explorer = vault.explorer;
  const wb = data?.walletBalances || {};
  const usdc = data?.state?.tokens?.USDC;
  const eth = data?.state?.tokens?.ETH;

  const bal = (w) =>
    !w || w.usdc == null
      ? null
      : `${Number(w.usdc).toLocaleString()} USDC${Number(w.eth) > 0 ? ` · ${Number(w.eth).toFixed(3)} ETH` : ""}`;

  const rows = [
    {
      k: "Vault", addr: vault.address,
      balance: usdc
        ? `${fmtBase(usdc.vaultBalance, "USDC")} USDC${eth && Number(eth.vaultBalance) > 0 ? ` · ${fmtBase(eth.vaultBalance, "ETH")} ETH` : ""}`
        : null,
      note: "agent can spend within caps",
    },
    { k: "Primary", addr: data.wallets?.primary || null, balance: bal(wb.primary), note: "your self-custody key" },
    { k: "Savings", addr: data.wallets?.savings || null, balance: bal(wb.savings), note: "where “move to savings” lands" },
  ];

  // one number for "how much money do I have?" — vault + primary + savings
  const usdcParts = [usdc ? Number(usdc.vaultBalance) / 1e6 : null, wb.primary?.usdc != null ? Number(wb.primary.usdc) : null, wb.savings?.usdc != null ? Number(wb.savings.usdc) : null];
  const ethParts = [eth ? Number(eth.vaultBalance) / 1e18 : null, wb.primary?.eth != null ? Number(wb.primary.eth) : null, wb.savings?.eth != null ? Number(wb.savings.eth) : null];
  const haveTotal = usdcParts.some((x) => x != null);
  const totalUsdc = usdcParts.filter((x) => x != null).reduce((a, x) => a + x, 0);
  const totalEth = ethParts.filter((x) => x != null).reduce((a, x) => a + x, 0);

  return (
    <Card title="Your wallets & balances" note="Every address you own, with live on-chain balances.">
      <div className="acct-list">
        {rows.map((r) => (
          <div className="acct-row" key={r.k}>
            <span className="k">{r.k}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
              {r.addr ? (
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                  <CopyText text={r.addr} />
                  <AddressQr addr={r.addr} label={r.k} />
                </span>
              ) : (
                <span className="mono dim">provisioning…</span>
              )}
              <span className="faint" style={{ fontSize: 11.5 }}>{r.note}</span>
            </div>
            <span
              className="mono"
              style={{
                fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
                color: r.balance && r.k === "Savings" && Number(wb.savings?.usdc || 0) > 0 ? "var(--ok, #34d399)" : "inherit",
              }}
              title={r.balance || "balance appears once your vault is live"}
            >
              {r.balance ?? "–"}
            </span>
          </div>
        ))}
        {haveTotal ? (
          <div className="acct-row" style={{ borderTop: "1px solid var(--line, #ffffff14)", paddingTop: 8 }}>
            <span className="k">Σ Total</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <span className="faint" style={{ fontSize: 11.5 }}>everything you own, all wallets combined</span>
            </div>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>
              {totalUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
              {totalEth > 0 ? ` · ${totalEth.toFixed(3)} ETH` : ""}
            </span>
          </div>
        ) : null}
        {vault.deployTx ? (
          <div className="acct-row">
            <span className="k">Deploy tx</span>
            <TxLink hash={vault.deployTx} explorer={explorer} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Agent kill-switch status + pause/resume — shared by Home and Security. */
export function AgentStatusPanel({ me }) {
  const data = me.data;
  const state = data?.state;
  const [busy, setBusy] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const active = state?.agentStatusName === "Active";

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiAuth(`/me/agent/${active ? "pause" : "resume"}`, { method: "POST" });
      toast(active ? "Agent paused; it will refuse every action until you resume" : "Agent resumed");
      setConfirmPause(false);
      me.refresh();
    } catch (e) {
      toast(e?.message || "couldn't reach the vault", { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Agent status" note="The kill switch is an on-chain fact, not a setting the AI can ignore.">
      <div className="row" style={{ flexWrap: "wrap", gap: 14 }}>
        <AgentChip name={state?.agentStatusName} />
        <div className="grow" style={{ minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {active ? "Aegis is operating within your limits" : "Aegis is not acting"}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            {active
              ? "It can pay, swap and answer, inside your caps and payee list only."
              : active === false && state?.agentStatusName === "Paused"
                ? "Every request is refused and logged on-chain until you resume."
                : "The agent cannot act on your vault in this state."}
          </div>
        </div>
        {active ? (
          confirmPause ? (
            <div className="inline-confirm">
              <span className="q">The agent will refuse every action until you resume. Pause?</span>
              <button className="btn danger" onClick={toggle} disabled={busy}>
                {busy ? <Spinner /> : "Yes, pause"}
              </button>
              <button className="btn" onClick={() => setConfirmPause(false)} disabled={busy}>Cancel</button>
            </div>
          ) : (
            <button className="btn danger" onClick={() => setConfirmPause(true)}>⏸ Pause agent</button>
          )
        ) : (
          <button className="btn primary" onClick={toggle} disabled={busy}>
            {busy ? <Spinner /> : "▶ Resume agent"}
          </button>
        )}
      </div>
    </Card>
  );
}
