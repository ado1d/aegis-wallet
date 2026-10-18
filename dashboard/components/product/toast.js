"use client";

// Tiny toast system with zero prop-drilling: any component calls
//   toast("Saved")                -> plain message
//   toast("Done", { hash, explorer, kind: "ok" })  -> message + tx link
// The <Toasts/> renderer is mounted once by the product app shell / pages.

import { useEffect, useState } from "react";

let seq = 0;

export function toast(message, opts = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("aegis-toast", {
      detail: { id: ++seq, message, kind: opts.kind || "ok", hash: opts.hash || null, explorer: opts.explorer || null },
    })
  );
}

export function Toasts() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const onToast = (e) => {
      const t = e.detail;
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 6000);
    };
    window.addEventListener("aegis-toast", onToast);
    return () => window.removeEventListener("aegis-toast", onToast);
  }, []);

  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast t-${t.kind}`}>
          <span className="t-msg">{t.message}</span>
          {t.hash ? (
            <a
              className="t-link"
              href={t.explorer ? `${t.explorer}/tx/${t.hash}` : undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!t.explorer) e.preventDefault();
              }}
              title={t.explorer ? "view on the explorer" : t.hash}
            >
              view tx ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
