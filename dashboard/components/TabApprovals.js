"use client";

import { useState } from "react";
import { api, fmtBase, timeAgo, labelFor, riskClass } from "./lib.js";
import { Badge, Card, Empty, ErrorNote, TxRow, Spinner } from "./ui.js";

// Approvals: the human-in-the-loop queue. On-chain truth via /approvals;
// approve = owner approveTx + executeApprovedTx (exempt from caps: the human
// outranks the policy); reject = owner rejectTx (auto-logged on-chain).
export default function TabApprovals({ approvals, state, refresh }) {
  const [busyId, setBusyId] = useState(null);
  const [results, setResults] = useState([]); // {id, action, ok, hashes, note}
  const [error, setError] = useState(null);

  const act = async (id, action) => {
    setBusyId(id);
    setError(null);
    try {
      const r = await api(`/approvals/${id}/${action}`, { method: "POST", body: null });
      const hashes = action === "approve"
        ? [r.result?.approveTx?.hash, r.result?.executeApprovedTx?.hash].filter(Boolean)
        : [r.result?.rejectTx?.hash].filter(Boolean);
      setResults((rs) => [
        { id, action, ok: true, hashes, note: action === "approve" ? "approved + executed on-chain" : "rejected (auto-logged as OwnerRejected)" },
        ...rs.filter((x) => x.id !== id),
      ]);
      refresh?.();
    } catch (e) {
      setResults((rs) => [{ id, action, ok: false, note: e.message }, ...rs]);
    } finally {
      setBusyId(null);
    }
  };

  const pending = approvals?.pending || [];

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card
        title="Pending approvals"
        note="Proposals over the per-tx cap or the rolling window, or in the risk review band. Nothing moves until the owner decides."
      >
        <ErrorNote>{error}</ErrorNote>
        {!approvals ? (
          <p style={{ color: "var(--dim)" }}><Spinner /> loading the on-chain queue…</p>
        ) : pending.length === 0 ? (
          <Empty>
            Queue empty. The agent is operating inside its policy envelope.
            Trigger a queue with “Pay the landlord 1200 for this month's rent” (over the per-tx cap).
          </Empty>
        ) : (
          <div className="rowlist">
            {pending.map((p) => {
              const label = labelFor(p.to, state?.whitelist);
              return (
                <div className="row" key={p.id}>
                  <span className="chip">#{p.id}</span>
                  <div className="grow">
                    <div className="title">
                      {fmtBase(p.amount, p.token)} {p.token} →{" "}
                      <span className="mono">{`${p.to.slice(0, 10)}…${p.to.slice(-6)}`}</span>
                      {label ? ` (${label})` : ""}
                    </div>
                    <div className="meta">
                      “{p.reason}” · proposed by <span className="mono">{`${(p.proposedBy || "").slice(0, 8)}…`}</span> ·{" "}
                      {timeAgo(p.createdAt * 1000)} · {p.status}
                    </div>
                  </div>
                  <span className={`badge b-${riskClass(p.riskScore) === "ok" ? "ok" : riskClass(p.riskScore) === "warn" ? "warn" : "bad"}`}>
                    risk {p.riskScore}
                  </span>
                  <button className="btn primary" disabled={busyId === p.id} onClick={() => act(p.id, "approve")}>
                    {busyId === p.id ? <Spinner /> : "Approve + execute"}
                  </button>
                  <button className="btn danger" disabled={busyId === p.id} onClick={() => act(p.id, "reject")}>
                    Reject
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {results.length ? (
        <Card title="Decisions this session" note="Owner actions and their transaction hashes: direct evidence.">
          <div className="rowlist">
            {results.map((r, i) => (
              <div className={`result-banner ${r.ok ? "ok" : "bad"}`} key={i}>
                <b>
                  #{r.id} {r.action}
                </b>{" "}
                · {r.note}
                {r.hashes?.length ? (
                  <div style={{ marginTop: 6 }}>
                    {r.hashes.map((h) => (
                      <TxRow key={h} label="on-chain" hash={h} />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
