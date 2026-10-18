"use client";

import { fmtBase, shortAddr } from "./lib.js";
import { Badge, Card, Stat } from "./ui.js";

// Contract: addresses & config (env-driven, never hard-coded), the decision
// matrix, the security model, and the live evidence counters.
export default function TabContract({ health, state, approvals }) {
  const isSepolia = /sepolia/i.test(health?.chain || "");
  const ex = (a) =>
    isSepolia ? `https://sepolia.etherscan.io/address/${a}` : null;

  const addrs = [
    { label: "AegisVault", value: health?.vault, note: "the guarded wallet (CP1, tag cp1.1)" },
    { label: "Swap venue (MockSwap)", value: health?.venue, note: "fixed-rate guarded venue, owner-settable" },
    { label: "MockUSDC", value: health?.usdc, note: "6-decimal demo asset, open mint by design" },
  ];

  const matrix = [
    ["Prompt injection detected (any channel)", "reject", "logRejection (RiskEngine), before ANY parsing"],
    ["Ambiguous / incomplete / future-dated", "clarify", "none, asks back, never guesses"],
    ["Question (“how much…”, “status”)", "query", "none, answered from live state"],
    ["Inside policy + risk < 30", "execute", "agentExecute / agentSwap"],
    ["Over per-tx cap or rolling window", "queue", "submitForApproval → owner approve + execute"],
    ["Risk 30–59 (review band)", "queue", "submitForApproval with the risk score attached"],
    ["Whitelist fail / balance / paused / risk ≥ 60", "reject", "logRejection: the exact violated check is named"],
    ["Mirror says ALLOW but simulation reverts", "reject", "logRejection: mirror and chain must never diverge"],
  ];

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="grid stats">
        <Stat label="Chain" value={isSepolia ? "Sepolia" : "anvil (local)"} sub={health?.chain} small />
        <Stat label="Parser" value={health?.llmProvider || "–"} sub="LLM first, deterministic fallback" small />
        <Stat label="Sentiment layer" value={health?.sentiment || "–"} sub="FinBERT + MiniLM (optional)" small />
        <Stat label="Mode" value={health?.dryRun ? "dry-run" : "live"} sub={health?.dryRun ? "decisions only, no broadcast" : "real transactions"} small />
      </div>

      <Card title="Deployed addresses" note="Env-driven (agent/.env); the dashboard never hard-codes a point of failure.">
        <table className="tbl">
          <thead><tr><th>Contract</th><th>Address</th><th>What it is</th></tr></thead>
          <tbody>
            {addrs.map((a) => (
              <tr key={a.label}>
                <td>{a.label}</td>
                <td className="mono">
                  {a.value ? (
                    ex(a.value) ? (
                      <a href={ex(a.value)} target="_blank" rel="noreferrer">{shortAddr(a.value)}</a>
                    ) : (
                      shortAddr(a.value)
                    )
                  ) : "–"}
                </td>
                <td style={{ color: "var(--dim)" }}>{a.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid two">
        <Card title="The decision matrix" note="Every situation has exactly one deterministic outcome (agent README §3).">
          <table className="tbl">
            <thead><tr><th>Situation</th><th>Decision</th><th>On-chain action</th></tr></thead>
            <tbody>
              {matrix.map(([situation, dec, act]) => (
                <tr key={situation}>
                  <td>{situation}</td>
                  <td><Badge kind={dec === "reject" ? "reject" : dec === "queue" ? "queue" : dec === "execute" ? "execute" : "neutral"}>{dec}</Badge></td>
                  <td style={{ color: "var(--dim)" }}>{act}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Security model (CP1 + CP1.1)" note="What the chain enforces, independent of the AI.">
          <table className="tbl">
            <tbody>
              {[
                ["Enforcement order", "status → whitelist → per-tx → rolling 24h window → balance"],
                ["Rolling window", "per-token 64-entry ring buffer; entries expire exactly 24h after the spend; no midnight burst"],
                ["Fail-closed", "window buffer uncertain → transfer refuses (Aegis__DailyWindowUncertain)"],
                ["Human-approved txs", "exempt from caps; the human outranks the policy"],
                ["Swap guard", "sell side metered by the same window (unified accounting) + atomic minOut"],
                ["Kill switch", "pause/revoke is sticky; only the owner re-grants via setAgent"],
                ["No oracle by design", "policies are per-asset amounts; no price feed to manipulate"],
              ].map(([k, v]) => (
                <tr key={k}><td style={{ width: "34%", color: "var(--dim)" }}>{k}</td><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid stats">
        <Stat label="Rejection ledger" value={state?.rejectionCount ?? "–"} sub="logRejection events on-chain" />
        <Stat label="Pending queue" value={approvals?.pending?.length ?? "–"} sub="proposals awaiting the human" />
        <Stat
          label="24h window used (USDC)"
          value={state ? `${fmtBase(state.tokens.USDC.spentInWindow, "USDC")}` : "–"}
          sub={state ? `of ${fmtBase(state.tokens.USDC.dailyLimit, "USDC")} , unified (transfers + swaps)` : ""}
        />
        <Stat
          label="Whitelist"
          value={state?.whitelist?.length ?? "–"}
          sub="absolute recipient floor"
        />
      </div>
    </div>
  );
}
