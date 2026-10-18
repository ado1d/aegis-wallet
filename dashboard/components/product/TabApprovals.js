"use client";

// Approvals — the human-in-the-loop queue for the user's own vault.

import { useState } from "react";
import { apiAuth } from "../auth.js";
import { fmtBase, timeAgo, labelFor, usePoll } from "../lib.js";
import { Card, Empty, ErrorNote, Spinner } from "../ui.js";
import { RiskChip, CopyText, tsOf } from "./bits.js";
import { toast } from "./toast.js";

export default function TabApprovals({ me, active }) {
  const explorer = me.data?.vault?.explorer;
  const list = usePoll(() => apiAuth("/me/approvals"), 5000, active);
  const [busyId, setBusyId] = useState(null); // {id, action}

  const pending = list.data?.pending || [];
  const whitelist = me.data?.state?.whitelist || [];
  const payees = me.data?.payees || [];

  const labelFor2 = (addr) =>
    labelFor(addr, whitelist) ||
    (payees.find((p) => p.address?.toLowerCase() === String(addr || "").toLowerCase())?.label ?? null);

  const act = async (id, action) => {
    if (busyId) return;
    setBusyId({ id, action });
    try {
      const r = await apiAuth(`/me/approvals/${id}/${action}`, { method: "POST" });
      const res = r.result || {};
      const item = pending.find((x) => x.id === id) || {};
      const hash =
        action === "approve"
          ? res.executeApprovedTx?.hash || res.approveTx?.hash
          : res.rejectTx?.hash;
      toast(
        action === "approve"
          ? `Approved: ${fmtBase(item.amount || 0, item.token || "USDC")} sent on-chain`
          : "Rejected, logged on-chain as your decision",
        { hash, explorer }
      );
      list.refresh();
      me.refresh();
    } catch (e) {
      toast(e?.message || "the transaction didn't go through", { kind: "bad" });
      list.refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title="Waiting for your approval"
      note="Over-cap or unusual requests land here. Nothing moves until you decide, and your decision is written on-chain."
    >
      <ErrorNote>{list.error}</ErrorNote>
      {list.loading && !list.data ? (
        <p className="dim"><Spinner /> loading the queue…</p>
      ) : pending.length === 0 ? (
        <Empty>
          Nothing waiting. Over-cap or unusual requests land here for your sign-off.
        </Empty>
      ) : (
        <div>
          {pending.map((p) => (
            <div className="card ap-card" key={p.id}>
              <div className="ap-head">
                <span className="ap-amount">{fmtBase(p.amount, p.token)} {p.token}</span>
                <span className="dim">→</span>
                <CopyText text={p.to} display={`${p.to.slice(0, 8)}…${p.to.slice(-6)}`} />
                {labelFor2(p.to) ? <span className="chip">{labelFor2(p.to)}</span> : null}
                <RiskChip score={p.riskScore} />
                <span className="faint" style={{ fontSize: 11.5, marginLeft: "auto" }}>{timeAgo(tsOf(p.createdAt))}</span>
              </div>
              <p className="ap-reason">“{p.reason}” (Aegis)</p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  className="btn primary"
                  onClick={() => act(p.id, "approve")}
                  disabled={!!busyId}
                >
                  {busyId?.id === p.id && busyId.action === "approve" ? <><Spinner /> broadcasting…</> : "✓ Approve"}
                </button>
                <button
                  className="btn danger"
                  onClick={() => act(p.id, "reject")}
                  disabled={!!busyId}
                >
                  {busyId?.id === p.id && busyId.action === "reject" ? <><Spinner /> broadcasting…</> : "✕ Reject"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
