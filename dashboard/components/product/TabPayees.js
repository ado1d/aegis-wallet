"use client";

// Payees — the whitelist the vault contract enforces. The agent can ONLY send
// to this list; adding/removing is an owner-signed transaction.

import { useState } from "react";
import { apiAuth } from "../auth.js";
import { Card, Empty, Spinner } from "../ui.js";
import { CopyText } from "./bits.js";
import { toast } from "./toast.js";

const CATEGORIES = ["rent", "family", "shopping", "services", "other"];

export default function TabPayees({ me }) {
  const payees = me.data?.payees || [];
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("other");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null); // address being confirmed/removed

  const add = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!label.trim()) {
      toast("Give the payee a name", { kind: "bad" });
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
      toast("Address must be a full 0x… address", { kind: "bad" });
      return;
    }
    setBusy(true);
    try {
      const r = await apiAuth("/me/payees", {
        method: "POST",
        body: { label: label.trim(), address: address.trim(), category },
      });
      toast(`“${label.trim()}” whitelisted, enforced on-chain`, { hash: r?.result?.hash, explorer: me.data?.vault?.explorer });
      setLabel(""); setAddress(""); setCategory("other");
      me.refresh();
    } catch (err) {
      toast(err?.message || "couldn't add the payee", { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (addr) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await apiAuth(`/me/payees?address=${addr}`, { method: "DELETE" });
      toast("Payee removed; the agent can no longer pay them", { hash: r?.result?.hash, explorer: me.data?.vault?.explorer });
      setDeleting(null);
      me.refresh();
    } catch (err) {
      toast(err?.message || "couldn't remove the payee", { kind: "bad" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card
        title="Your payees"
        note="Payees are enforced by the vault contract; the agent can ONLY send to this list, no matter what anyone asks it to do."
      >
        {payees.length === 0 ? (
          <Empty>No payees yet. Add the people you actually pay: rent, family, whoever.</Empty>
        ) : (
          <div className="rowlist">
            {payees.map((p) => (
              <div className="row" key={p.id || p.address}>
                <div className="grow" style={{ minWidth: 180 }}>
                  <div className="title">{p.label}</div>
                  <div className="meta" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <CopyText text={p.address} display={`${p.address.slice(0, 8)}…${p.address.slice(-6)}`} />
                  </div>
                </div>
                <span className="chip">{p.category || "other"}</span>
                {deleting === p.address ? (
                  <span className="inline-confirm">
                    <span className="q">Remove?</span>
                    <button className="btn danger" onClick={() => remove(p.address)} disabled={busy}>
                      {busy ? <Spinner /> : "Yes, remove"}
                    </button>
                    <button className="btn" onClick={() => setDeleting(null)} disabled={busy}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn danger" onClick={() => setDeleting(p.address)} disabled={!!deleting}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Add a payee" note="Whitelisting is an owner-signed transaction; it takes effect on-chain immediately.">
        <form className="formgrid" onSubmit={add} noValidate>
          <div className="field">
            <label htmlFor="py-label">Name</label>
            <input
              id="py-label" value={label} onChange={(e) => setLabel(e.target.value)}
              disabled={busy} placeholder="Landlord" maxLength={32}
            />
          </div>
          <div className="field">
            <label htmlFor="py-cat">Category</label>
            <select id="py-cat" value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field span2">
            <label htmlFor="py-addr">Address</label>
            <input
              id="py-addr" value={address} onChange={(e) => setAddress(e.target.value)}
              disabled={busy} placeholder="0x…" spellCheck={false} className="mono-in"
              style={{ fontFamily: "var(--mono)" }}
            />
          </div>
          <div className="span2">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? <Spinner /> : "＋ Add payee"}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
