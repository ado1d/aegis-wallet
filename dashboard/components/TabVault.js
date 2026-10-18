"use client";

import { useState } from "react";
import { api, fmtBase, timeAgo, shortAddr, shortHash, REJECTION_CATEGORIES, usePoll } from "./lib.js";
import { Badge, Card, Empty, ErrorNote, TxRow, Spinner } from "./ui.js";

// Vault: owner controls (kill switch), whitelist floor, demo faucet (guarded),
// and the on-chain rejection ledger.
export default function TabVault({ state, refresh }) {
  const rejections = usePoll(() => api("/rejections?limit=20"), 6000);
  const faucet = usePoll(() => api("/faucet/status"), 30000);

  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseResult, setPauseResult] = useState(null);

  const [wlAddr, setWlAddr] = useState("");
  const [wlLabel, setWlLabel] = useState("");
  const [wlBusy, setWlBusy] = useState(false);
  const [wlResult, setWlResult] = useState(null);

  const [fcAddr, setFcAddr] = useState("");
  const [fcBusy, setFcBusy] = useState(false);
  const [fcResult, setFcResult] = useState(null);

  const agentActive = state?.agentStatusName === "Active";

  const togglePause = async () => {
    setPauseBusy(true);
    try {
      const r = await api(agentActive ? "/owner/pause" : "/owner/resume", { method: "POST", body: null });
      setPauseResult({ ok: true, action: r.action, hash: r.result?.hash });
      refresh?.();
    } catch (e) {
      setPauseResult({ ok: false, msg: e.message });
    } finally {
      setPauseBusy(false);
    }
  };

  const addWhitelist = async () => {
    setWlBusy(true);
    setWlResult(null);
    try {
      const r = await api("/whitelist", { method: "POST", body: { address: wlAddr, label: wlLabel || "Unlabeled" } });
      setWlResult({ ok: true, hash: r.result?.hash, label: r.label });
      setWlAddr(""); setWlLabel("");
      refresh?.();
    } catch (e) {
      setWlResult({ ok: false, msg: e.message });
    } finally {
      setWlBusy(false);
    }
  };

  const claimFaucet = async () => {
    setFcBusy(true);
    setFcResult(null);
    try {
      const r = await api("/faucet/claim", { method: "POST", body: { address: fcAddr } });
      setFcResult(r); // {ok, tx, amountUsdc} or {ok:false, error}
    } catch (e) {
      setFcResult({ ok: false, error: e.message });
    } finally {
      setFcBusy(false);
    }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid two">
        <Card title="Kill switch" note="Owner pause is immediate and on-chain; the agent key can do nothing while paused.">
          <div className="rowlist">
            <div className="row">
              <Badge kind={agentActive ? "ok" : "bad"}>{state?.agentStatusName || "…"}</Badge>
              <div className="grow">
                <div className="title">{agentActive ? "Agent active" : "Agent paused"}</div>
                <div className="meta">
                  {agentActive
                    ? "commands inside policy execute autonomously"
                    : "every command is refused and written to the rejection ledger"}
                </div>
              </div>
              <button className={agentActive ? "btn danger" : "btn primary"} onClick={togglePause} disabled={pauseBusy}>
                {pauseBusy ? <Spinner /> : agentActive ? "Pause agent" : "Resume agent"}
              </button>
            </div>
            {pauseResult ? (
              pauseResult.ok ? (
                <div className="result-banner ok">
                  {pauseResult.action} on-chain <TxRow label="tx" hash={pauseResult.hash} />
                </div>
              ) : (
                <div className="result-banner bad">{pauseResult.msg}</div>
              )
            ) : null}
          </div>
        </Card>

        <Card title="Whitelist floor" note="The absolute recipient floor; an AI mistake cannot route around it.">
          <div className="formrow">
            <input style={{ flex: 2, minWidth: 220 }} placeholder="0x… address" value={wlAddr} onChange={(e) => setWlAddr(e.target.value)} />
            <input className="label-in" style={{ flex: 1, minWidth: 120 }} placeholder="label (e.g. Mom)" value={wlLabel} onChange={(e) => setWlLabel(e.target.value)} />
            <button className="btn primary" onClick={addWhitelist} disabled={wlBusy || !/^0x[0-9a-fA-F]{40}$/.test(wlAddr)}>
              {wlBusy ? <Spinner /> : "Add"}
            </button>
          </div>
          {wlResult ? (
            wlResult.ok ? (
              <div className="result-banner ok">
                “{wlResult.label}” whitelisted on-chain <TxRow label="tx" hash={wlResult.hash} />
              </div>
            ) : (
              <div className="result-banner bad">{wlResult.msg}</div>
            )
          ) : null}
          <table className="tbl">
            <thead>
              <tr><th>Address</th><th>Label</th></tr>
            </thead>
            <tbody>
              {(state?.whitelist || []).map((w) => (
                <tr key={w.address}>
                  <td className="mono">{shortAddr(w.address)}</td>
                  <td>{w.label}</td>
                </tr>
              ))}
              {(state?.whitelist || []).length === 0 ? (
                <tr><td colSpan={2}><Empty>no whitelisted recipients</Empty></td></tr>
              ) : null}
            </tbody>
          </table>
        </Card>
      </div>

      <Card
        title="Demo faucet (mock USDC)"
        note="For the hosted judge quickstart. Guard rails live in the agent: per-address cooldown + global daily cap; repeated claims are refused."
      >
        <div className="formrow">
          <input style={{ flex: 2, minWidth: 240 }} placeholder="0x… claim address" value={fcAddr} onChange={(e) => setFcAddr(e.target.value)} />
          <button className="btn primary" onClick={claimFaucet} disabled={fcBusy || !/^0x[0-9a-fA-F]{40}$/.test(fcAddr)}>
            {fcBusy ? <Spinner /> : `Claim ${faucet.data?.amountUsdc ?? "…"} USDC`}
          </button>
        </div>
        <div className="meta" style={{ color: "var(--faint)", fontSize: 11.5 }}>
          {faucet.data
            ? `${faucet.data.claimsToday}/${faucet.data.dailyMax} claims today · ${faucet.data.cooldownMin}-min per-address cooldown · ${faucet.data.enabled ? "enabled" : "disabled"}`
            : "loading faucet status…"}
        </div>
        {fcResult ? (
          fcResult.ok ? (
            <div className="result-banner ok">
              sent {fcResult.amountUsdc} mock USDC {fcResult.simulated ? "(simulated, dry-run)" : ""}{" "}
              <TxRow label="mint tx" hash={fcResult.tx} />
            </div>
          ) : (
            <div className="result-banner bad">{fcResult.error}</div>
          )
        ) : null}
      </Card>

      <Card
        title="Rejection ledger (on-chain)"
        note="Every refusal (policy, risk engine, injection, owner) is evidence: logRejection with a category."
      >
        <ErrorNote>{rejections.error}</ErrorNote>
        {!rejections.data ? (
          <p style={{ color: "var(--dim)" }}>{rejections.loading ? <Spinner /> : null} loading…</p>
        ) : (rejections.data.rejections || []).length === 0 ? (
          <Empty>No rejections yet. Try sending to a stranger address from the AI Console.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>#</th><th>Category</th><th>Actor</th><th>Reason hash</th><th>When</th></tr>
            </thead>
            <tbody>
              {rejections.data.rejections.map((r) => (
                <tr key={r.index}>
                  <td>{r.index}</td>
                  <td><Badge kind="neutral">{REJECTION_CATEGORIES[r.category] || `cat ${r.category}`}</Badge></td>
                  <td className="mono">{shortAddr(r.actor)}</td>
                  <td className="mono">{shortHash(r.reasonHash)}</td>
                  <td>{timeAgo(r.at * 1000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
