"use client";

// ConnectWallet — EIP-1193 browser-wallet funding (MetaMask and any injected
// wallet: Rabby, Brave, Coinbase…). The desktop twin of the QR buttons: the
// ONLY thing it can do is send FROM the user's own wallet TO one of the
// user's own Aegis addresses. It never touches the agent, the vault logic,
// or any Aegis key — there is nothing here for the agent to get wrong.
//
// Hard safety gate: Sepolia-only. The chain is checked before the very
// first send and re-checked on every chainChanged, so this button can never
// move real mainnet funds. No wallet installed -> an honest message that
// points to the QR alternative instead of a shrug.
//
// SSR-safe: window.ethereum is only ever read inside handlers/effects —
// never at render time (prerender + hydration stay identical).

import { useEffect, useRef, useState } from "react";
import { shortAddr } from "../lib.js";
import { Card } from "../ui.js";
import { toast } from "./toast.js";
import { TxLink } from "./bits.js";

const SEPOLIA_ID = "0xaa36a7"; // chainId 11155111, lowercase hex
const SEPOLIA_CHAIN = {
  chainId: SEPOLIA_ID,
  chainName: "Sepolia testnet",
  nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.sepolia.org"],
  blockExplorerUrls: ["https://sepolia.etherscan.io"],
};

const ethOf = (weiHex) => {
  try {
    return Number(BigInt(weiHex) * 1n) / 1e18;
  } catch {
    return 0;
  }
};
const weiHex = (eth) => "0x" + BigInt(Math.round(Number(eth) * 1e18)).toString(16);

function provider() {
  if (typeof window === "undefined") return null;
  const p = window.ethereum;
  if (!p) return null;
  // some wallets expose an array (multiple extensions fighting for the slot)
  if (Array.isArray(p.providers) && p.providers.length) {
    return p.providers.find((x) => x?.isMetaMask) || p.providers[0];
  }
  return p;
}

const REQUEST_REJECTED = 4001;

export default function ConnectWallet({ me }) {
  const data = me?.data || {};
  const explorer = data?.vault?.explorer || "https://sepolia.etherscan.io";

  const dests = [
    { id: "vault", label: "Vault", addr: data?.vault?.address, note: "where the agent spends within caps" },
    { id: "primary", label: "Primary", addr: data?.wallets?.primary, note: "your self-custody key" },
    { id: "savings", label: "Savings", addr: data?.wallets?.savings, note: "where “to savings” lands" },
  ].filter((d) => d.addr);

  const [acct, setAcct] = useState(null);
  const [chainOk, setChainOk] = useState(false);
  const [balance, setBalance] = useState(null); // ETH number of the CONNECTED wallet
  const [dest, setDest] = useState(dests[0]?.id || null);
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState(null); // {kind:'sent'|'confirmed'|'reverted'|'pending', hash}
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);
  useEffect(() => () => clearInterval(pollRef.current), []);

  const reset = () => {
    clearInterval(pollRef.current);
    setAcct(null);
    setChainOk(false);
    setBalance(null);
    setPhase(null);
    setMsg(null);
    setAmount("");
  };

  // keep in sync with the wallet: account swaps, disconnects, chain switches
  useEffect(() => {
    if (!acct) return;
    const p = provider();
    if (!p?.on) return;
    const onAccounts = (as) => {
      if (!as?.length) return reset();
      setAcct(as[0]);
    };
    const onChain = (id) => {
      const ok = String(id).toLowerCase() === SEPOLIA_ID;
      setChainOk(ok);
      if (!ok) {
        setPhase(null);
        setMsg("Your wallet left Sepolia. Switch it back before funding — this button only works on testnet.");
      }
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acct]);

  const connect = async () => {
    const p = provider();
    if (!p) {
      setMsg(
        "No browser wallet detected. Install MetaMask (metamask.io) — or just tap a QR button and send from your phone's wallet instead."
      );
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const as = await p.request({ method: "eth_requestAccounts" });
      if (!as?.length) return;
      setAcct(as[0]);

      let id = String(await p.request({ method: "eth_chainId" })).toLowerCase();
      if (id !== SEPOLIA_ID) {
        try {
          await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_ID }] });
        } catch (e) {
          if (e?.code === 4902 || e?.data?.originalError?.code === 4902) {
            await p.request({ method: "wallet_addEthereumChain", params: [SEPOLIA_CHAIN] });
          } else if (e?.code === REQUEST_REJECTED) {
            setMsg("You declined the network switch. This button only works on Sepolia — nothing can be sent on other networks.");
          }
        }
        id = String(await p.request({ method: "eth_chainId" })).toLowerCase();
      }
      setChainOk(id === SEPOLIA_ID);
      if (id !== SEPOLIA_ID) {
        setMsg("Your wallet is on another network. Switch it to Sepolia first — this button refuses to send anywhere else.");
        return;
      }
      const balHex = await p.request({ method: "eth_getBalance", params: [as[0], "latest"] });
      setBalance(ethOf(balHex));
    } catch (e) {
      if (e?.code === REQUEST_REJECTED) setMsg("You cancelled — nothing was sent.");
      else setMsg(e?.message || "the wallet refused the connection");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const p = provider();
    const target = dests.find((d) => d.id === dest);
    const amt = Number(amount);
    if (!p || !acct || !target) return;
    if (!chainOk) {
      setMsg("Switch your wallet to Sepolia first — this button refuses to send anywhere else.");
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg("Enter an amount of ETH above 0.");
      return;
    }
    setBusy(true);
    setMsg(null);
    setPhase(null);
    try {
      const hash = await p.request({
        method: "eth_sendTransaction",
        params: [{ from: acct, to: target.addr, value: weiHex(amt) }],
      });
      setPhase({ kind: "sent", hash, to: target.label });
      toast(`Sent to your ${target.label} — waiting for Sepolia to confirm`, { hash, explorer });

      // honest confirmation: poll the receipt ourselves, up to ~100s
      clearInterval(pollRef.current);
      let tries = 0;
      pollRef.current = setInterval(async () => {
        tries++;
        try {
          const rc = await p.request({ method: "eth_getTransactionReceipt", params: [hash] });
          if (rc) {
            clearInterval(pollRef.current);
            if (String(rc.status) === "0x1") {
              setPhase({ kind: "confirmed", hash, to: target.label });
              toast(`Confirmed on Sepolia → your ${target.label}`, { hash, explorer });
            } else {
              setPhase({ kind: "reverted", hash, to: target.label });
              setMsg(`The transaction reverted on-chain. Nothing landed — check the explorer for why.`);
            }
            if (target.id !== "vault") me?.refresh?.();
          } else if (tries > 25) {
            clearInterval(pollRef.current);
            setPhase({ kind: "pending", hash, to: target.label });
          }
        } catch {
          /* poll hiccup — keep waiting */
        }
      }, 4000);
    } catch (e) {
      if (e?.code === REQUEST_REJECTED) setMsg("You cancelled — nothing was sent.");
      else setMsg(e?.message?.slice(0, 160) || "the wallet refused the transaction");
    } finally {
      setBusy(false);
    }
  };

  const maxFill = async () => {
    if (balance == null) return;
    setAmount(String(Number(balance.toFixed(6))));
  };

  const target = dests.find((d) => d.id === dest);

  return (
    <Card
      title="Fund from your browser wallet"
      note="Connect MetaMask (or any browser wallet) and send Sepolia ETH straight to one of your addresses — the desktop twin of the QR buttons."
    >
      {!acct ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <button className="btn" onClick={connect} disabled={busy}>
              {busy ? "Opening your wallet…" : "⬡ Connect wallet"}
            </button>
          </div>
          <p className="faint" style={{ fontSize: 12, margin: 0 }}>
            No wallet yet? Tap any QR button and send from your phone instead — same result.
          </p>
          {msg ? <p className="cw-msg" role="alert">{msg}</p> : null}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="cw-head">
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{shortAddr(acct)}</span>
            <span className={`badge ${chainOk ? "b-ok" : "b-bad"}`}>
              {chainOk ? "Sepolia" : "wrong network"}
            </span>
            {balance != null ? (
              <span className="faint" style={{ fontSize: 12 }}>{balance.toFixed(4)} ETH</span>
            ) : null}
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={reset} style={{ padding: "5px 12px", fontSize: 12 }}>
              Disconnect
            </button>
          </div>

          <div className="cw-dest" role="radiogroup" aria-label="destination address">
            {dests.map((d) => (
              <button
                key={d.id}
                type="button"
                className={dest === d.id ? "active" : ""}
                onClick={() => { setDest(d.id); setPhase(null); setMsg(null); }}
                title={d.addr}
                role="radio"
                aria-checked={dest === d.id}
              >
                <span style={{ fontWeight: 700 }}>{d.label}</span>
                <span className="mono faint" style={{ fontSize: 11 }}>{shortAddr(d.addr)}</span>
              </button>
            ))}
          </div>
          {target ? (
            <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
              → your {target.label} · {target.note}
            </p>
          ) : null}

          <div className="cw-amtrow">
            <input
              inputMode="decimal"
              placeholder="amount in ETH"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && send()}
              aria-label="amount in ETH"
              disabled={busy}
            />
            <button type="button" className="btn" onClick={maxFill} disabled={balance == null || busy}>
              max
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={send}
              disabled={busy || !chainOk || !(Number(amount) > 0)}
            >
              {busy ? "Asking your wallet…" : "Send ETH"}
            </button>
          </div>

          {phase ? (
            <div className="cw-phase">
              {phase.kind === "sent" ? <span>sending to your {phase.to} — watch your wallet's activity, or: </span> : null}
              {phase.kind === "confirmed" ? <span style={{ color: "var(--ok)" }}>confirmed on Sepolia → your {phase.to} · </span> : null}
              {phase.kind === "reverted" ? <span style={{ color: "var(--bad)" }}>reverted on-chain · </span> : null}
              {phase.kind === "pending" ? <span className="faint">still pending after ~100s · </span> : null}
              <TxLink hash={phase.hash} explorer={explorer} label="tx:" />
            </div>
          ) : null}
          {msg ? <p className="cw-msg" role="alert">{msg}</p> : null}

          <p className="faint" style={{ fontSize: 11, margin: 0 }}>
            Sepolia testnet only — this button is unable to send real mainnet ETH. For test dollars (USDC) use the faucet above.
          </p>
        </div>
      )}
    </Card>
  );
}
