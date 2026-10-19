"use client";

// Help assistant — the floating guide. Available from every product tab:
// one tap on the "?" button opens a chat with Aegis Help, which answers
// questions about Aegis, the user's own setup, or crypto basics — clearly
// and simply, in the user's own language.
//
// Advisory by construction: the panel only ever calls POST /me/help, a route
// that cannot parse intents, execute or queue anything. The disclaimer sits
// under the input so the promise ("I explain, I never move money") is on
// screen exactly where the user is typing.

import { useEffect, useRef, useState } from "react";
import { apiAuth } from "../auth.js";

const CHIPS = [
  "What can Aegis do?",
  "What are my limits?",
  "Why was my payment blocked?",
  "How do I get test money?",
];

const INTRO =
  "Hi, I'm Aegis Help. Ask me anything about how Aegis works, your own limits and balances, or crypto basics — I'll keep it simple, in your own language.";

function sourceTag(meta) {
  if (!meta) return null;
  if (meta.source === "llm") return "answered by AI · grounded in your live setup";
  if (meta.source === "faq") return "built-in answers (AI offline right now)";
  if (meta.source === "cooldown") return "slow down a touch";
  return null;
}

export default function HelpAssistant() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState([]); // {role:'user'|'help', text, meta?, at}
  const inputRef = useRef(null);
  const endRef = useRef(null);

  // Esc closes; focus the input when the panel opens
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    setTimeout(() => inputRef.current?.focus(), 60);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 40);
  }, [session, open]);

  const send = async (text) => {
    const t = (text || "").trim();
    if (!t || busy) return;
    setBusy(true);
    setInput("");
    setSession((s) => [...s, { role: "user", text: t, at: Date.now() }]);
    try {
      // transcript rides along so follow-ups work across serverless cold
      // starts; the server sanitizes and caps it before it reaches the model
      const history = session
        .slice(-6)
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
      const r = await apiAuth("/me/help", { method: "POST", body: { text: t, history } });
      setSession((s) => [...s, { role: "help", text: r.answer, meta: r.meta, at: Date.now() }]);
    } catch (e) {
      const msg =
        e?.status === 429
          ? "One question at a time — ask again in a second."
          : "I couldn't reach the help service just now. Try again in a moment.";
      setSession((s) => [...s, { role: "help", text: msg, error: true, at: Date.now() }]);
    } finally {
      setBusy(false);
    }
  };

  const showChips = session.length === 0;

  return (
    <>
      <button
        type="button"
        className={`help-fab ${open ? "hidden" : ""}`}
        onClick={() => setOpen(true)}
        aria-label="open Aegis Help"
        title="Aegis Help — ask anything"
      >
        <span aria-hidden="true">?</span>
      </button>

      {open ? (
        <section className="help-panel" role="dialog" aria-modal="false" aria-label="Aegis Help">
          <header className="hp-head">
            <div className="hp-title">
              <span className="hp-name">Aegis Help</span>
              <span className="hp-tag">guidance only</span>
            </div>
            <button className="hp-close" onClick={() => setOpen(false)} aria-label="close help">
              ✕
            </button>
          </header>

          <div className="hp-body" role="log" aria-label="help conversation">
            <div className="chat-row agent">
              <div className="bubble bubble-agent hp-intro">{INTRO}</div>
            </div>

            {session.map((m, i) =>
              m.role === "user" ? (
                <div className="chat-row user" key={i}>
                  <div className="bubble bubble-user">{m.text}</div>
                </div>
              ) : (
                <div className="chat-row agent" key={i}>
                  <div className={`bubble bubble-agent ${m.error ? "hp-error" : ""}`} style={{ whiteSpace: "pre-wrap" }}>
                    {m.text}
                    {sourceTag(m.meta) ? <div className="hp-src">{sourceTag(m.meta)}</div> : null}
                  </div>
                </div>
              )
            )}

            {busy ? (
              <div className="chat-row agent">
                <div className="bubble bubble-agent">
                  <span className="faint" style={{ fontSize: 12, marginRight: 8 }}>Aegis Help is thinking</span>
                  <span className="chat-thinking"><i /><i /><i /></span>
                </div>
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          {showChips ? (
            <div className="chips hp-chips">
              {CHIPS.map((c) => (
                <button key={c} onClick={() => send(c)} disabled={busy}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}

          <div className="hp-inputrow">
            <input
              ref={inputRef}
              value={input}
              placeholder="ask anything about Aegis or crypto…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send(input)}
              disabled={busy}
              aria-label="question for Aegis Help"
              maxLength={280}
            />
            <button onClick={() => send(input)} disabled={busy || !input.trim()}>
              {busy ? "…" : "Send"}
            </button>
          </div>
          <p className="hp-disclaimer">
            Simple answers, any language. I explain — I never move money; for that, use the Console.
          </p>
        </section>
      ) : null}
    </>
  );
}
