"use client";

// The product app — header (status, bell, account), left tab nav, and the
// seven product tabs. Client-only; all data flows through the agent API.

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation.js";
import Link from "next/link.js";
import { useMe, useRequireAuth, logout, apiAuth } from "../../components/auth.js";
import { ProductGate } from "../../components/product/mode.js";
import { AgentChip, tsOf } from "../../components/product/bits.js";
import { Toasts } from "../../components/product/toast.js";
import { timeAgo } from "../../components/lib.js";
import TabHome from "../../components/product/TabHome.js";
import TabConsole from "../../components/product/TabConsole.js";
import TabApprovals from "../../components/product/TabApprovals.js";
import TabActivity from "../../components/product/TabActivity.js";
import TabPayees from "../../components/product/TabPayees.js";
import TabLimits from "../../components/product/TabLimits.js";
import TabSecurity from "../../components/product/TabSecurity.js";
import HelpAssistant from "../../components/product/HelpAssistant.js";

const NAV = [
  { id: "home", label: "Home", icon: "🏠" },
  { id: "console", label: "Console", icon: "💬" },
  { id: "approvals", label: "Approvals", icon: "⏳" },
  { id: "activity", label: "Activity", icon: "🕘" },
  { id: "payees", label: "Payees", icon: "👥" },
  { id: "limits", label: "Limits", icon: "🎚" },
  { id: "security", label: "Security", icon: "🔐" },
];

function AppInner() {
  const router = useRouter();
  const { ready, authed } = useRequireAuth();
  const me = useMe();
  const [tab, setTab] = useState("home");
  const [pendingCmd, setPendingCmd] = useState(null);

  const runInConsole = useCallback((text) => {
    setTab("console");
    setPendingCmd({ text, n: Date.now() });
  }, []);

  if (!ready || !authed) {
    return <div className="ob-page"><p className="faint">checking your session…</p></div>;
  }

  const data = me.data;
  const vaultState = data?.vault?.state;
  const provisioning = vaultState && vaultState !== "done";

  return (
    <div className="pa-shell">
      <header className="pa-header">
        <Link className="wordmark" href="/" aria-label="aegisAiWallet home">
          <span className="glyph"><img src="/logo-mark.png" alt="" /></span>
          <span className="name">aegis<b className="ai">Ai</b>Wallet</span>
        </Link>
        <AgentChip name={data?.state?.agentStatusName || (provisioning ? "…" : undefined)} />
        <div style={{ flex: 1 }} />
        <Bell me={me} />
        <span className="email" title={data?.user?.email || ""}>{data?.user?.email || "…"}</span>
        <button
          className="btn logout"
          onClick={async () => { await logout(); router.push("/"); }}
        >
          Log out
        </button>
      </header>

      {provisioning ? (
        <div className="warnstrip" style={{ margin: "14px 22px 0", maxWidth: 1200 }}>
          Your vault is still being provisioned ({vaultState}). Balances and actions
          unlock the moment it&apos;s live.{" "}
          <Link href="/start" style={{ color: "inherit", fontWeight: 600 }}>Watch progress →</Link>
        </div>
      ) : null}

      <div className="pa-body">
        <nav className="pa-nav" aria-label="app sections">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`pa-nav-item ${tab === n.id ? "active" : ""}`}
              onClick={() => setTab(n.id)}
              aria-current={tab === n.id ? "page" : undefined}
            >
              <span className="ic" aria-hidden="true">{n.icon}</span>
              {n.label}
              {n.id === "approvals" && data?.pendingApprovals > 0 ? (
                <span className="count">{data.pendingApprovals}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <main className="pa-main">
          {tab === "home" ? <TabHome me={me} onRun={runInConsole} /> : null}
          {tab === "console" ? <TabConsole me={me} onNavigate={setTab} pending={pendingCmd} /> : null}
          {tab === "approvals" ? <TabApprovals me={me} active={tab === "approvals"} /> : null}
          {tab === "activity" ? <TabActivity me={me} active={tab === "activity"} /> : null}
          {tab === "payees" ? <TabPayees me={me} /> : null}
          {tab === "limits" ? <TabLimits me={me} /> : null}
          {tab === "security" ? <TabSecurity me={me} /> : null}
        </main>
      </div>
      <Toasts />
      <HelpAssistant />
    </div>
  );
}

/* ── notifications bell ─────────────────────────────────────────────────── */

function Bell({ me }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const notes = me.data?.notifications || [];
  const unread = me.data?.unread || 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markRead = async (n) => {
    if (!n.read) {
      try {
        await apiAuth(`/me/notifications/${n.id}/read`, { method: "POST" });
        me.refresh();
      } catch {
        /* non-critical */
      }
    }
  };

  return (
    <div className="bell-wrap" ref={wrapRef}>
      <button
        className="bell-btn"
        onClick={() => setOpen(!open)}
        aria-label={`notifications${unread ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
      >
        🔔
        {unread > 0 ? <span className="bell-count">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="bell-panel">
          <div className="bp-head">Notifications</div>
          <div className="bell-list">
            {notes.length === 0 ? (
              <div className="bell-item" style={{ cursor: "default" }}>
                <div className="bb" style={{ marginTop: 0 }}>All quiet, nothing to catch up on.</div>
              </div>
            ) : (
              notes.map((n) => (
                <div
                  key={n.id}
                  className={`bell-item ${n.read ? "" : "unread"}`}
                  onClick={() => markRead(n)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && markRead(n)}
                >
                  <div className="bt">
                    <span>{n.title}</span>
                    <span className="when">{timeAgo(tsOf(n.createdAt))}</span>
                  </div>
                  {n.body ? <div className="bb">{n.body}</div> : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function AppPage() {
  return (
    <ProductGate>
      <AppInner />
    </ProductGate>
  );
}
