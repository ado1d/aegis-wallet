// Tiny presentational primitives shared by all tabs.

import { shortHash } from "./lib.js";

export function Badge({ kind = "neutral", children }) {
  return <span className={`badge b-${kind}`}>{children}</span>;
}

export function Card({ title, note, children, className = "" }) {
  return (
    <div className={`card ${className}`}>
      {title ? <h3>{title}</h3> : null}
      {note ? <p className="note">{note}</p> : null}
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, small }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className={`value${small ? " small" : ""}`}>{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function Bar({ value, max, limitHuman, warnAt = 0.7, badAt = 0.9 }) {
  const v = Number(value) || 0;
  const m = Number(max) || 1;
  const pct = Math.min(100, Math.round((v / m) * 100));
  const cls = pct / 100 >= badAt ? "bad" : pct / 100 >= warnAt ? "warn" : "";
  return (
    <div>
      <div className={`bar ${cls}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="pct">
        {pct}% of {limitHuman} limit
      </div>
    </div>
  );
}

export function TxRow({ label, hash }) {
  if (!hash) return null;
  return (
    <div className="hashline">
      <span className="lbl">{label}</span>
      <span className="mono">{shortHash(hash)}</span>
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return <div className="error">{children}</div>;
}

export function Spinner() {
  return <span className="spin" />;
}

export function Copyable({ text, display }) {
  return (
    <span
      className="mono"
      style={{ cursor: "pointer" }}
      title="click to copy"
      onClick={() => navigator.clipboard?.writeText(text)}
    >
      {display || text}
    </span>
  );
}
