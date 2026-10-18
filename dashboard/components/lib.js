// Shared client library: agent-URL resolution, API fetch, formatters, polling.

export const DEFAULT_AGENT_URL =
  process.env.NEXT_PUBLIC_AGENT_URL || "http://127.0.0.1:8787";
const LS_KEY = "aegis:agentUrl";

export function getAgentUrl() {
  if (typeof window === "undefined") return DEFAULT_AGENT_URL;
  try {
    return window.localStorage.getItem(LS_KEY) || DEFAULT_AGENT_URL;
  } catch {
    return DEFAULT_AGENT_URL;
  }
}

export function setAgentUrl(u) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, u.replace(/\/$/, ""));
  } catch {
    /* private mode etc. — default still applies */
  }
}

export async function api(path, { method = "GET", body, base, headers } = {}) {
  const url = (base || getAgentUrl()).replace(/\/$/, "") + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (e) {
    throw new Error(`cannot reach the agent at ${url}. Is it running? (${e.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ── formatters ─────────────────────────────────────────────────────────── */

const DEC = { USDC: 6, ETH: 18 };

export function fmtBase(baseStr, symbol) {
  const d = DEC[symbol] ?? 6;
  const n = Number(baseStr) / 10 ** d;
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString(undefined, { maximumFractionDigits: d === 6 ? 2 : 4 });
}

export function shortAddr(a) {
  const s = String(a || "");
  return s.length === 42 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s || "–";
}
export function shortHash(h) {
  const s = String(h || "");
  return s.length > 20 ? `${s.slice(0, 12)}…${s.slice(-8)}` : s || "–";
}

export function timeAgo(ts) {
  if (!ts) return "–";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// AegisVault RejectionCategory enum (0-8)
export const REJECTION_CATEGORIES = [
  "Uncategorised",
  "Cap per transaction",
  "Rolling-window cap",
  "Whitelist",
  "Agent inactive",
  "Owner rejected",
  "Risk engine",
  "Slippage",
  "Balance",
];

export const DECISION_CLASS = {
  execute: "b-execute",
  queue: "b-queue",
  reject: "b-reject",
  swap: "b-swap",
  query: "b-query",
  clarify: "b-clarify",
  error: "b-reject", // broadcast FAILED — nothing moved; red so it can't be mistaken for execute
};

export function riskClass(score) {
  if (score >= 60) return "bad";
  if (score >= 30) return "warn";
  return "ok";
}

/** Label the whitelist entry for a recipient address, if any. */
export function labelFor(address, whitelist) {
  const hit = (whitelist || []).find(
    (w) => w.address.toLowerCase() === String(address || "").toLowerCase()
  );
  return hit ? hit.label : null;
}

/* ── polling hook (pauses when the tab is hidden) ───────────────────────── */

import { useEffect, useRef, useState, useCallback } from "react";

export function usePoll(fn, ms = 4000, enabled = true) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return; // pause in background tabs
      await run();
    };
    run();
    const iv = setInterval(tick, ms);
    const vis = () => document.hidden || run();
    document.addEventListener("visibilitychange", vis);
    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [ms, enabled, run]);

  return { data, error, loading, refresh: run };
}
