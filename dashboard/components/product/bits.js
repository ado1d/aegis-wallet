"use client";

// Small product-UI building blocks shared across tabs. Kept dependency-free
// and SSR-safe (localStorage/clipboard only touched in handlers/effects).

import { useEffect, useRef, useState } from "react";
import { shortHash, shortAddr, riskClass } from "../lib.js";

/* ── clipboard with a fallback for non-secure contexts ─────────────────── */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/** mono text + copy affordance with brief "copied" feedback */
export function CopyText({ text, display, className = "" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    if (await copyText(text)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <button
      type="button"
      className={`copytext mono ${className}`}
      onClick={onClick}
      title={`copy ${text}`}
      aria-label={`copy ${text}`}
    >
      {display || text}
      <span className={`copied ${copied ? "show" : ""}`}>{copied ? "copied" : "⧉"}</span>
    </button>
  );
}

/* ── explorer links (graceful without an explorer) ─────────────────────── */

export function explorerTxUrl(explorer, hash) {
  return explorer && hash ? `${explorer.replace(/\/$/, "")}/tx/${hash}` : null;
}
export function explorerAddrUrl(explorer, addr) {
  return explorer && addr ? `${explorer.replace(/\/$/, "")}/address/${addr}` : null;
}

export function TxLink({ hash, explorer, label }) {
  if (!hash) return null;
  const url = explorerTxUrl(explorer, hash);
  return url ? (
    <a className="txlink mono" href={url} target="_blank" rel="noreferrer" title={hash}>
      {label ? `${label} ` : ""}{shortHash(hash)} ↗
    </a>
  ) : (
    <span className="txlink mono" title={hash}>
      {label ? `${label} ` : ""}{shortHash(hash)}
    </span>
  );
}

export function AddrLink({ addr, explorer, label }) {
  if (!addr) return <span className="mono dim">–</span>;
  const url = explorerAddrUrl(explorer, addr);
  return url ? (
    <a className="txlink mono" href={url} target="_blank" rel="noreferrer" title={addr}>
      {label ? `${label} ` : ""}{shortAddr(addr)} ↗
    </a>
  ) : (
    <span className="txlink mono" title={addr}>
      {label ? `${label} ` : ""}{shortAddr(addr)}
    </span>
  );
}

/* ── chips ─────────────────────────────────────────────────────────────── */

export function AgentChip({ name }) {
  const n = String(name || "…");
  const kind = n === "Active" ? "ok" : n === "Paused" ? "warn" : n === "…" ? "neutral" : "bad";
  return <span className={`badge b-${kind}`}>● {n}</span>;
}

export function RiskChip({ score }) {
  const s = Number(score);
  const kind = riskClass(s);
  return <span className={`badge b-${kind}`}>risk {s}</span>;
}

/* ── modal (confirm dialogs) ───────────────────────────────────────────── */

export function Modal({ title, children, onClose, danger = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${danger ? "danger" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        {title ? <h3>{title}</h3> : null}
        {children}
      </div>
    </div>
  );
}

/* ── misc ──────────────────────────────────────────────────────────────── */

/** avoids hydration mismatch for localStorage-derived UI */
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/** createdAt normalizer: approvals use epoch seconds, feeds use ISO strings */
export function tsOf(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x < 1e12 ? x * 1000 : x; // seconds -> ms
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : Number(x) || 0;
}

/** a one-line "spent / cap" progress meter for a token */
export function CapMeter({ spent, limit, symbol, fmt }) {
  const s = Number(spent) || 0;
  const l = Number(limit) || 0;
  const pct = l > 0 ? Math.min(100, Math.round((s / l) * 100)) : 0;
  const cls = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
  return (
    <div className="capmeter">
      <div className={`bar ${cls}`}><i style={{ width: `${pct}%` }} /></div>
      <div className="capmeta">
        {fmt(spent, symbol)} of {fmt(limit, symbol)} {symbol} spent in the last 24h
      </div>
    </div>
  );
}
