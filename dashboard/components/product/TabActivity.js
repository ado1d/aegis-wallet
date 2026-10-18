"use client";

// Activity — the full account feed: commands, owner ops, provisioning, exports.

import { apiAuth } from "../auth.js";
import { timeAgo, DECISION_CLASS, usePoll } from "../lib.js";
import { Badge, Card, Empty, ErrorNote, Spinner } from "../ui.js";
import { TxLink, tsOf } from "./bits.js";

const KIND_ICON = {
  command: "⌨",
  "owner-op": "🔑",
  provision: "🚀",
  "key-export": "⬇",
  system: "ℹ",
};

export default function TabActivity({ me, active }) {
  const explorer = me.data?.vault?.explorer;
  const feed = usePoll(() => apiAuth("/me/activity?limit=50"), 8000, active);
  const items = feed.data?.activities || [];

  return (
    <Card
      title="Activity"
      note="Everything that happened on this account: commands, your owner operations, provisioning and key exports."
      className="activity-card"
    >
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="btn" onClick={() => feed.refresh()} disabled={feed.loading}>
          {feed.loading ? <Spinner /> : "↻ Refresh"}
        </button>
      </div>
      <ErrorNote>{feed.error}</ErrorNote>
      {feed.loading && !feed.data ? (
        <p className="dim"><Spinner /> loading your activity…</p>
      ) : items.length === 0 ? (
        <Empty>Nothing yet. Head to the Console and say hello.</Empty>
      ) : (
        <div className="feed">
          {items.map((a) => (
            <div className="feed-item" key={a.id}>
              <div className="fic" aria-hidden="true">{KIND_ICON[a.kind] || "•"}</div>
              <div className="body">
                <div className="l1">
                  {a.text ? <span>“{a.text}”</span> : <span style={{ fontWeight: 600 }}>{kindLabel(a)}</span>}
                  {a.decision && a.kind === "command" ? (
                    <> <Badge kind={DECISION_CLASS[a.decision] || "neutral"}>{a.decision}</Badge></>
                  ) : null}
                </div>
                {a.explanation ? <div className="l2">{a.explanation}</div> : null}
                {a.txHash ? <div style={{ marginTop: 4 }}><TxLink hash={a.txHash} explorer={explorer} /></div> : null}
              </div>
              <span className="when">{timeAgo(tsOf(a.createdAt))}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function kindLabel(a) {
  switch (a.kind) {
    case "owner-op": return "Owner action";
    case "provision": return "Vault provisioning";
    case "key-export": return "Key export";
    case "system": return "Account";
    default: return "Command";
  }
}
