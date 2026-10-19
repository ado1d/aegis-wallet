"use client";

// Small product-UI building blocks shared across tabs. Kept dependency-free
// and SSR-safe (localStorage/clipboard only touched in handlers/effects).

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
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

/* ── QR code for an address (scan-to-fund from any mobile wallet) ──────── */

function QrGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <rect x="0" y="0" width="5" height="5" rx="1" />
      <rect x="9" y="0" width="5" height="5" rx="1" />
      <rect x="0" y="9" width="5" height="5" rx="1" />
      <rect x="7.5" y="7.5" width="2" height="2" />
      <rect x="11" y="8" width="2" height="2" />
      <rect x="8" y="11" width="2" height="2" />
      <rect x="12" y="12" width="1.5" height="1.5" />
    </svg>
  );
}

/** Renders a small QR button next to an address; clicking opens a modal with
 *  a scannable QR (bare address — the format every wallet scanner accepts),
 *  the full address, and a copy affordance. */
export function AddressQr({ addr, label = "address" }) {
  const [open, setOpen] = useState(false);
  if (!addr) return null;
  return (
    <>
      <button
        type="button"
        className="qr-btn"
        onClick={() => setOpen(true)}
        title={`show QR code for this ${label.toLowerCase()}`}
        aria-label={`show QR code for this ${label.toLowerCase()}`}
      >
        <QrGlyph />
      </button>
      {open ? (
        <Modal title={`${label} address`} onClose={() => setOpen(false)}>
          <div className="m-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <div className="qr-card">
              <QRCodeSVG value={addr} size={196} marginSize={0} />
            </div>
            <p className="mono" style={{ fontSize: 12, wordBreak: "break-all", textAlign: "center", margin: 0 }}>{addr}</p>
            <p className="faint" style={{ fontSize: 11.5, textAlign: "center", margin: 0 }}>
              scan with any wallet app to send funds to this address
            </p>
          </div>
          <div className="m-actions" style={{ justifyContent: "center" }}>
            <CopyText text={addr} display="copy address" />
            <button className="btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </Modal>
      ) : null}
    </>
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
