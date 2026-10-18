"use client";

import { useState, useEffect, useCallback } from "react";
import { getAgentUrl, setAgentUrl, api, usePoll } from "./lib.js";
import TabOverview from "./TabOverview.js";
import TabConsole from "./TabConsole.js";
import TabApprovals from "./TabApprovals.js";
import TabPortfolio from "./TabPortfolio.js";
import TabVault from "./TabVault.js";
import TabContract from "./TabContract.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "console", label: "AI Console" },
  { id: "approvals", label: "Approvals", count: "approvals" },
  { id: "portfolio", label: "Portfolio" },
  { id: "vault", label: "Vault" },
  { id: "contract", label: "Contract" },
];

// The CP3 six-tab judge dashboard — unchanged logic, moved out of app/page.js
// so the app router entry can mode-switch (judge vs product) without touching
// this component. Renders at / in judge mode and at /judge in every deployment.
export default function JudgeDashboard() {
  const [tab, setTab] = useState("overview");
  const [url, setUrl] = useState(null); // agent URL (resolved client-side)
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => setUrl(getAgentUrl()), []);

  const health = usePoll(() => api("/health"), 10000);
  const state = usePoll(() => api("/state"), 4000);
  const approvals = usePoll(() => api("/approvals"), 5000);
  const refreshAll = useCallback(() => {
    health.refresh();
    state.refresh();
    approvals.refresh();
  }, [health, state, approvals]);

  const [pendingCmd, setPendingCmd] = useState(null); // {text} to run in console

  const runInConsole = (text) => {
    setTab("console");
    setPendingCmd({ text, n: Date.now() });
  };

  const applyUrl = () => {
    setAgentUrl(draft);
    setUrl(draft.replace(/\/$/, ""));
    setEditing(false);
    health.refresh();
    state.refresh();
    approvals.refresh();
  };

  const ok = health.data?.ok === true;
  const pendingCount = approvals.data?.pending?.length || 0;

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <div className="mark">A</div>
          <div>
            <h1>AEGIS WALLET</h1>
            <div className="sub">
              AI as a Financial Participant · a guarded autonomous wallet · Checkpoint 3
            </div>
          </div>
        </div>
        <div className="spacer" />
        <div className="conn">
          <span className={`dot ${health.error || health.data?.ok === false ? "bad" : ok ? "ok" : ""}`} />
          {health.loading && !health.data ? (
            "connecting…"
          ) : health.error ? (
            "agent unreachable"
          ) : ok ? (
            <>
              connected · <span className="chip"><span className="k">parser</span> {health.data.llmProvider}</span>
              <span className="chip"><span className="k">chain</span> {chainShort(health.data.chain)}</span>
              {health.data.dryRun ? <span className="badge b-warn">dry-run</span> : null}
            </>
          ) : (
            "unknown state"
          )}
        </div>
        <button className="gear" onClick={() => { setDraft(getAgentUrl()); setEditing(!editing); }}>
          ⚙ agent URL
        </button>
      </header>

      {editing ? (
        <div className="urlbox">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyUrl()}
            placeholder="http://127.0.0.1:8787"
            spellCheck={false}
          />
          <button className="btn primary" onClick={applyUrl}>Apply</button>
          <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          <div className="hint">
            stored in this browser (localStorage). Point the dashboard at any running
            Aegis agent: local anvil, or the hosted demo later.
          </div>
        </div>
      ) : null}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "approvals" && pendingCount > 0 ? <span className="n">{pendingCount}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <TabOverview health={health.data} state={state.data} onRun={runInConsole} refresh={refreshAll} />
      ) : null}
      {tab === "console" ? (
        <TabConsole state={state.data} refresh={refreshAll} pending={pendingCmd} />
      ) : null}
      {tab === "approvals" ? (
        <TabApprovals approvals={approvals.data} state={state.data} refresh={refreshAll} />
      ) : null}
      {tab === "portfolio" ? <TabPortfolio state={state.data} /> : null}
      {tab === "vault" ? <TabVault state={state.data} refresh={refreshAll} /> : null}
      {tab === "contract" ? <TabContract health={health.data} state={state.data} approvals={approvals.data} /> : null}

      <footer className="footer">
        <span>CP1 contracts (Foundry) → CP2 agent (this API) → CP3 dashboard (this page)</span>
        <span>every autonomous action is pre-flight simulated, policy-checked, and re-checked on-chain</span>
      </footer>
    </div>
  );
}

function chainShort(url) {
  if (!url) return "–";
  if (/sepolia/i.test(url)) return "sepolia";
  if (/localhost|127\.0\.0\.1/.test(url)) return "anvil (local)";
  return url.replace(/^https?:\/\//, "").slice(0, 24);
}
