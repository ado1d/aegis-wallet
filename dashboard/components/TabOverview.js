"use client";

import { api, fmtBase, timeAgo, DECISION_CLASS, usePoll } from "./lib.js";
import { Badge, Card, Stat, Bar, ErrorNote, Empty, Spinner } from "./ui.js";

// Overview: judge quickstart (plan CP3 item 5) + live vault vitals + recent decisions.
export default function TabOverview({ health, state, onRun, refresh }) {
  const history = usePoll(() => api("/history?limit=6"), 6000);
  if (!state) {
    return (
      <Card>
        <p style={{ color: "var(--dim)", display: "flex", gap: 10, alignItems: "center" }}>
          <Spinner /> loading vault state from the agent…
        </p>
        <ErrorNote>{!health ? "" : ""}</ErrorNote>
      </Card>
    );
  }

  const usdc = state.tokens?.USDC || {};
  const eth = state.tokens?.ETH || {};
  const agentOk = state.agentStatusName === "Active";
  const funded = Number(usdc.vaultBalance) > 0;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid two">
        <Card
          title="Quickstart: the 3-step demo"
          note="What an unattended judge (or you) does in the first five minutes."
        >
          <div className="steps">
            <div className={`step ${health?.ok ? "done" : ""}`}>
              <div className="num">1</div>
              <div>
                <div className="t">Agent reachable</div>
                <div className="d">
                  {health?.ok ? (
                    <span className="ok-inline">connected</span>
                  ) : (
                    "not connected, start the agent (node src/server.js)"
                  )}{" "}
                  · parser <span className="mono">{health?.llmProvider || "–"}</span>
                </div>
              </div>
            </div>
            <div className={`step ${funded ? "done" : ""}`}>
              <div className="num">2</div>
              <div>
                <div className="t">Vault funded & guarded</div>
                <div className="d">
                  {funded ? (
                    <>
                      <span className="ok-inline">
                        {fmtBase(usdc.vaultBalance, "USDC")} USDC
                      </span>{" "}
                      + {fmtBase(eth.vaultBalance, "ETH")} ETH · per-tx cap{" "}
                      {fmtBase(usdc.maxPerTx, "USDC")} · rolling 24h{" "}
                      {fmtBase(usdc.dailyLimit, "USDC")}
                    </>
                  ) : (
                    "deposit demo funds (see the CP2 quickstart)"
                  )}
                </div>
              </div>
            </div>
            <div className="step">
              <div className="num">3</div>
              <div>
                <div className="t">Run your first command</div>
                <div className="d">
                  plain English in, policy-checked on-chain action out.
                  <div style={{ marginTop: 8 }}>
                    <button className="btn primary" onClick={() => onRun("Sweep 800 dollars to my savings wallet")}>
                      ▶ Sweep 800 dollars to my savings wallet
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Agent status" note="The kill switch and the autonomy envelope are on-chain facts.">
          <div className="rowlist">
            <div className="row">
              <Badge kind={agentOk ? "ok" : "bad"}>{state.agentStatusName}</Badge>
              <div className="grow">
                <div className="title">{agentOk ? "Autonomous mode" : "Agent not active"}</div>
                <div className="meta">
                  {agentOk
                    ? "the agent key may act within the envelope; every action is re-checked on-chain"
                    : "pause is sticky; commands are refused and logged until resumed"}
                </div>
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <div className="title">Rolling 24h window (USDC)</div>
                <div className="meta">transfers AND swap sell-side count here; unified accounting</div>
                <Bar
                  value={usdc.spentInWindow}
                  max={usdc.dailyLimit}
                  limitHuman={fmtBase(usdc.dailyLimit, "USDC")}
                />
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <div className="title">Whitelist floor</div>
                <div className="meta">
                  {(state.whitelist || []).length} entr
                  {((state.whitelist || []).length === 1 ? "y" : "ies")}. The agent can
                  never pay anyone outside it, no matter how confident it feels
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid stats">
        <Stat
          label="Vault USDC"
          value={fmtBase(usdc.vaultBalance, "USDC")}
          sub={`spent in window ${fmtBase(usdc.spentInWindow, "USDC")}`}
        />
        <Stat
          label="Vault ETH"
          value={fmtBase(eth.vaultBalance, "ETH")}
          sub={`window ${fmtBase(eth.spentInWindow, "ETH")} of ${fmtBase(eth.dailyLimit, "ETH")}`}
        />
        <Stat
          label="Per-tx cap (USDC)"
          value={fmtBase(usdc.maxPerTx, "USDC")}
          sub="over this → human approval"
        />
        <Stat label="Rejection ledger" value={state.rejectionCount ?? 0} sub="on-chain refusals, evidence" />
      </div>

      <Card title="Recent decisions" note="Every command, its explanation, and its outcome (journal via /history).">
        {history.loading && !history.data ? (
          <p style={{ color: "var(--dim)" }}><Spinner /> loading…</p>
        ) : history.error ? (
          <ErrorNote>{history.error}</ErrorNote>
        ) : (history.data?.decisions || []).length === 0 ? (
          <Empty>No commands yet. Run step 3 above, or open the AI Console tab.</Empty>
        ) : (
          <div className="rowlist">
            {(history.data?.decisions || []).map((d, i) => (
              <div className="row" key={i}>
                <Badge kind={DECISION_CLASS[d.decision] || "neutral"}>{d.decision}</Badge>
                <div className="grow">
                  <div className="title" style={{ fontWeight: 500, fontSize: 12.5 }}>{d.text}</div>
                  <div className="meta">{d.explanation?.slice(0, 140)}</div>
                </div>
                <div className="meta">{timeAgo(d.at ? Date.parse(d.at) : 0)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
