"use client";

// Console — the chat-first heart of the product. User bubbles right, Aegis
// bubbles left with the decision badge and a collapsible decision trace.
// Spiritual successor of the judge dashboard's TabConsole.

import { useState, useEffect, useRef } from "react";
import { apiAuth } from "../auth.js";
import { DECISION_CLASS, riskClass, labelFor } from "../lib.js";
import { Badge } from "../ui.js";
import { TxLink } from "./bits.js";

const SUGGESTIONS = [
  "Move 100 USDC to savings",
  "Pay landlord 200 USDC",
  "Swap 200 USDC to ETH",
  "How much have I spent today?",
];

export default function TabConsole({ me, onNavigate, pending }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState([]); // {role, text?, d?, at}
  const endRef = useRef(null);

  const state = me.data?.state;
  const explorer = me.data?.vault?.explorer;

  const send = async (text) => {
    const t = (text || "").trim();
    if (!t || busy) return;
    setBusy(true);
    setInput("");
    setSession((s) => [...s, { role: "user", text: t, at: Date.now() }]);
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 40);
    try {
      const d = await apiAuth("/me/command", { method: "POST", body: { text: t } });
      setSession((s) => [...s, { role: "agent", d, at: Date.now() }]);
      if (d.decision === "queue") {
        setSession((s) => [...s, { role: "note", text: "Waiting for your approval", at: Date.now() }]);
      }
      me.refresh();
    } catch (e) {
      const msg =
        e?.status === 409
          ? "Your vault is still being provisioned; this usually takes a minute or two. Hang tight, then try again."
          : e?.message || "something went wrong reaching the agent";
      setSession((s) => [...s, { role: "agent", error: msg, at: Date.now() }]);
    } finally {
      setBusy(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 40);
    }
  };

  // command handed over from Home quick actions
  useEffect(() => {
    if (pending?.text) send(pending.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.n]);

  return (
    <div className="chat-wrap">
      <div className="chat-scroll" role="log" aria-label="conversation with Aegis">
        {session.length === 0 ? (
          <div className="empty" style={{ margin: "10px 0" }}>
            Say anything: “pay”, “swap”, “save” or just ask. Every reply shows
            exactly what Aegis understood, checked and did.
          </div>
        ) : null}

        {session.map((m, i) => {
          if (m.role === "user") {
            return (
              <div className="chat-row user" key={i}>
                <div className="bubble bubble-user">{m.text}</div>
              </div>
            );
          }
          if (m.role === "note") {
            return (
              <div className="chat-note" key={i}>
                <span>⏳ Waiting for your approval</span>
                <button className="btn" onClick={() => onNavigate("approvals")}>Open Approvals →</button>
              </div>
            );
          }
          return <AgentBubble key={i} m={m} explorer={explorer} whitelist={state?.whitelist} />;
        })}

        {busy ? (
          <div className="chat-row agent">
            <div className="bubble bubble-agent">
              <span className="faint" style={{ fontSize: 12, marginRight: 8 }}>Aegis is thinking</span>
              <span className="chat-thinking"><i /><i /><i /></span>
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="chat-inputpanel">
        {session.length < 2 ? (
          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} disabled={busy}>{s}</button>
            ))}
          </div>
        ) : null}
        <div className="chat-inputrow">
          <input
            value={input}
            placeholder='e.g. "move 100 dollars to savings"; any language works'
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
            disabled={busy}
            aria-label="message to Aegis"
            maxLength={280}
          />
          <button onClick={() => send(input)} disabled={busy || !input.trim()}>
            {busy ? "…" : "Send"}
          </button>
        </div>
        <p className="chat-disclaimer">
          Testnet play money. Requests over your caps land in Approvals instead of executing.
        </p>
      </div>
    </div>
  );
}

function AgentBubble({ m, explorer, whitelist }) {
  if (m.error) {
    return (
      <div className="chat-row agent">
        <div className="bubble bubble-agent" style={{ borderColor: "#f8717144" }}>{m.error}</div>
      </div>
    );
  }
  const d = m.d || {};
  const dTx = d.tx || {};
  const risk = d.risk;
  const intent = d.intent || {};
  const recipient = intent.recipient?.address || intent.recipient?.value || intent.recipient;
  const rLabel = recipient ? labelFor(recipient, whitelist) : null;
  const clarify = intent.action === "clarify" && intent.clarify;

  return (
    <div className="chat-row agent">
      <div className="bubble bubble-agent">
        <div className="who">
          <span className="name">Aegis</span>
          <Badge kind={DECISION_CLASS[d.decision] || "neutral"}>{d.decision || "reply"}</Badge>
          {d.queuedId != null ? <span className="chip">queue #{d.queuedId}</span> : null}
          {risk ? (
            <span className={`badge b-${riskClass(risk.score)}`}>risk {risk.score}/100</span>
          ) : null}
          {d.elapsedMs != null ? <span className="faint" style={{ fontSize: 11 }}>{d.elapsedMs} ms</span> : null}
        </div>

        <div>{clarify ? clarify : d.explanation}</div>

        <details className="chat-trace">
          <summary>decision trace: what Aegis understood, checked and did</summary>
          <div className="kv">
            {intent.action ? (
              <div className="item">
                <div className="k">Understood intent</div>
                <div className="v">
                  {intent.action}
                  {intent.amount ? ` · ${intent.amount} ${intent.token || ""}` : ""}
                  {intent.action === "swap" && intent.buyToken ? ` → ${intent.buyToken}` : ""}
                  {recipient ? (
                    <>
                      {" "}→ <span className="mono">{String(recipient).slice(0, 10)}…</span>
                      {rLabel ? ` (${rLabel})` : ""}
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            {d.injection ? (
              <div className="item">
                <div className="k">Injection scan</div>
                <div className="v" style={{ color: d.injection.detected ? "var(--bad)" : "var(--ok)" }}>
                  {d.injection.detected ? `DETECTED (${d.injection.channel}), refused before parsing` : "clean"}
                </div>
              </div>
            ) : null}

            {d.policy ? (
              <div className="item">
                <div className="k">Policy mirror</div>
                <div className="v">
                  {d.policy.outcome}
                  {d.policy.check ? ` · ${d.policy.check}` : ""}
                </div>
              </div>
            ) : null}

            {risk ? (
              <div className="item">
                <div className="k">Risk engine ({risk.band} band)</div>
                <div className="v">
                  score {risk.score}/100
                  {(risk.families || []).slice(0, 6).map((f) => (
                    <div key={f.family} className={`fam ${f.hit ? "hit" : ""}`}>
                      <span>{f.family}</span>
                      <span>{f.hit ? "flagged" : "clear"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {d.quote ? (
              <div className="item">
                <div className="k">Swap quote</div>
                <div className="v">
                  {d.quote.sellAmountHuman} {d.quote.sellSymbol} → {d.quote.expectedOutHuman} {d.quote.buySymbol}
                  {" "}· min out {d.quote.minOutHuman}
                </div>
              </div>
            ) : null}

            {d.onchainRejectionLogged ? (
              <div className="item">
                <div className="k">On-chain evidence</div>
                <div className="v" style={{ color: "var(--ok)" }}>refusal written to the public rejection ledger</div>
              </div>
            ) : null}
          </div>

          {Object.keys(dTx).length ? (
            <div style={{ marginTop: 8 }}>
              {Object.entries(dTx).map(([k, v]) => (
                <div className="hashline" key={k}>
                  <span className="lbl">{k}</span>
                  <TxLink hash={typeof v === "string" ? v : v?.hash} explorer={explorer} />
                </div>
              ))}
            </div>
          ) : null}
        </details>
      </div>
    </div>
  );
}
