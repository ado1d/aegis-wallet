// Per-user chain context — the bridge between accounts (auth/store) and the
// ONE decision matrix in executor.js. A user context has the exact shape
// executor.js expects from the `chain` module, but bound to the user's own
// vault: the agent stays the bounded operator; the OWNER signer is the
// account's embedded wallet.

import { ethers } from "ethers";
import { VAULT_ABI, AGENT_STATUS } from "./abi.js";
import { config, tokens, NATIVE, tokenByAddress, fromBaseUnits } from "./config.js";
import * as chain from "./chain.js";
import { journalFor } from "./journal.js";
import { getSigner } from "./auth.js";
import { getStore } from "./store.js";
import { provisionUser } from "./provision.js";

/** Executor-compatible chain context for a user (null until vault exists).
 *  SELF-HEAL: if the stored vault address has no code (the chain was reset
 *  underneath us — classic local-anvil situation where Postgres survives but
 *  the chain does not), re-provision right here instead of letting the first
 *  agentStatus() call die with "could not decode result data (value=0x…)".
 *  The provisioner is idempotent: deploy → configure → transfer → seed. */
export async function userChainContext(userId) {
  let row = await getStore().getVault(userId);
  if (!row?.address) return null;
  if ((await chain.provider.getCode(row.address)) === "0x") {
    console.warn(
      `  [self-heal] vault ${row.address} has no code (chain reset?) — re-provisioning user ${userId.slice(0, 8)}…`
    );
    // chain-reset evidence: the in-memory NonceManager counters are stale too
    // (they point past the fresh chain's nonce 0) — drop them first or every
    // recovery tx would wait for a nonce that never mines
    await chain.resetNonceManagers().catch(() => {});
    await getStore().upsertVault({ userId, state: "deploying", error: null });
    const heal = provisionUser(userId); // deduped per user, serialized globally
    // anvil re-provisions in ~1s; Sepolia needs 6+ txs at ~12s a block, so the
    // bound is chain-aware (30s local, 180s live, PROVISION_TIMEOUT_MS wins)
    const boundMs = await chain.provisionBoundMs().catch(() => 30_000);
    await Promise.race([heal, new Promise((r) => setTimeout(r, boundMs))]);
    row = await getStore().getVault(userId);
    if (!row?.address || (await chain.provider.getCode(row.address)) === "0x") return null;
  }
  const vault = new ethers.Contract(row.address, VAULT_ABI, chain.provider);
  const ownerSigner = await getSigner(userId, "primary", chain.provider);
  const journal = journalFor(userId);
  return {
    vault,
    vaultAsAgent: vault.connect(chain.agentWallet),
    vaultAsOwner: vault.connect(ownerSigner),
    snapshot: () => chain.snapshotOf(vault, chain.recentSpendsFrom(journal.read())),
    pendingQueue: () => chain.pendingQueueOf(vault),
    rejections: (n = 20) => chain.rejectionsOf(vault, n),
    send: chain.send,
    simulate: chain.simulate,
    quoteSwap: chain.quoteSwap,
    codesizeMap: chain.codesizeMap,
    queuedIdFromReceipt: chain.queuedIdFromReceipt,
  };
}

/** Live USDC + ETH balances of the user's OWN wallets (primary + savings).
 *  The vault balances live in view.state.tokens — this covers everything
 *  OUTSIDE the vault, so "how much money do I have?" finally has a complete
 *  answer and the dashboard can show every wallet in one place. Money moved
 *  to "Savings" lands on the savings address, which used to be invisible. */
const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

export async function walletBalancesView(userId) {
  const ks = await getStore().getKeystores(userId);
  const out = {};
  if (!ks) return out;
  const usdc = new ethers.Contract(tokens.USDC.address, ERC20_BALANCE_ABI, chain.provider);
  for (const kind of ["primary", "savings"]) {
    const addr = ks[kind + "Address"];
    if (!addr) continue;
    try {
      const [u, e] = await Promise.all([
        usdc.balanceOf(addr),
        chain.provider.getBalance(addr),
      ]);
      out[kind] = {
        address: addr,
        usdc: fromBaseUnits(u, tokens.USDC.decimals),
        eth: fromBaseUnits(e, 18),
      };
    } catch {
      out[kind] = { address: addr, usdc: null, eth: null }; // chain hiccup
    }
  }
  return out;
}

/** One-line "Wallets: Primary: X USDC · Savings: Y USDC" for query answers. */
export function walletBalancesLine(wb) {
  const parts = [];
  for (const [kind, label] of [["primary", "Primary wallet"], ["savings", "Savings wallet"]]) {
    const w = wb?.[kind];
    if (!w || w.usdc == null) continue;
    const ethPart = Number(w.eth) > 0 ? ` + ${Number(w.eth).toFixed(3)} ETH` : "";
    parts.push(`${label}: ${Number(w.usdc).toLocaleString()} USDC${ethPart}`);
  }
  return parts.length ? `Wallets: ${parts.join(" · ")}.` : "";
}

/** Full `/me` view for the dashboard. */
export async function meView(user) {
  const store = getStore();
  const [ks, vaultRow, payees, notes, info] = await Promise.all([
    store.getKeystores(user.id),
    store.getVault(user.id),
    store.listPayees(user.id),
    store.listNotifications(user.id, 30),
    chain.chainInfo(),
  ]);

  const view = {
    user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
    wallets: {
      primary: ks?.primaryAddress || null,
      savings: ks?.savingsAddress || null,
    },
    vault: vaultRow
      ? {
          address: vaultRow.address,
          state: vaultRow.state,
          error: vaultRow.error || null,
          deployTx: vaultRow.deployTx || null,
          explorer: info.explorer || null,
          chain: info.name,
          chainId: info.chainId,
        }
      : { address: null, state: "pending", error: null, explorer: info.explorer || null, chain: info.name, chainId: info.chainId },
    payees,
    notifications: notes,
    unread: notes.filter((n) => !n.read).length,
  };

  // live vault state (only once provisioning is done)
  if (vaultRow?.address && vaultRow.state === "done") {
    try {
      const ctx = await userChainContext(user.id);
      if (!ctx) {
        // vault went for re-provisioning (chain reset self-heal) — the
        // dashboard's provisioning strip picks this up on the next poll
        view.state = null;
      } else {
      const snap = await ctx.snapshot();
      const pending = await ctx.pendingQueue();
      view.state = {
        agentStatus: snap.agentStatus,
        agentStatusName: snap.agentStatusName,
        whitelist: snap.whitelist,
        rejectionCount: snap.rejectionCount,
        tokens: {
          USDC: {
            vaultBalance: snap.tokens.USDC.vaultBalance.toString(),
            maxPerTx: snap.tokens.USDC.maxPerTx.toString(),
            dailyLimit: snap.tokens.USDC.dailyLimit.toString(),
            spentInWindow: snap.tokens.USDC.spentInWindow.toString(),
          },
          ETH: {
            vaultBalance: snap.tokens.ETH.vaultBalance.toString(),
            maxPerTx: snap.tokens.ETH.maxPerTx.toString(),
            dailyLimit: snap.tokens.ETH.dailyLimit.toString(),
            spentInWindow: snap.tokens.ETH.spentInWindow.toString(),
          },
        },
      };
      view.pendingApprovals = pending.length;
      }
    } catch {
      view.state = null; // chain hiccup — dashboard retries on next poll
    }
  }

  // per-wallet balances (outside the vault): primary + savings addresses
  try {
    view.walletBalances = await walletBalancesView(user.id);
  } catch {
    view.walletBalances = null;
  }
  return view;
}

/** Persist a decision to the activity feed + raise notifications. */
export async function recordDecision(user, decision) {
  const store = getStore();
  const txHash =
    decision?.tx?.agentExecute || decision?.tx?.agentSwap || decision?.tx?.submitForApproval ||
    decision?.tx?.logRejection || null;
  await store.addActivity({
    userId: user.id,
    kind: "command",
    text: decision.text,
    decision: decision.decision,
    explanation: decision.explanation,
    txHash,
    detail: decision,
  });
  if (decision.decision === "queue") {
    await store.addNotification({
      userId: user.id,
      kind: "approval",
      title: "Payment waiting for your approval",
      body: decision.explanation?.slice(0, 300) || "",
    });
  } else if (decision.decision === "reject") {
    await store.addNotification({
      userId: user.id,
      kind: "blocked",
      title: "Aegis blocked a request",
      body: decision.explanation?.slice(0, 300) || "",
    });
  } else if (decision.decision === "error") {
    // honest failure: the broadcast did NOT happen — the user must know their
    // payment did not go through, not discover it later from a missing receipt
    await store.addNotification({
      userId: user.id,
      kind: "blocked",
      title: "A transfer could not be broadcast",
      body: decision.explanation?.slice(0, 300) || "",
    });
  }
}

/** Record an owner operation (approve/reject/pause/resume/limits/payee/withdraw). */
export async function recordOwnerOp(user, kind, explanation, txHash = null) {
  const store = getStore();
  await store.addActivity({ userId: user.id, kind: "owner-op", decision: kind, explanation, txHash });
  await store.addNotification({ userId: user.id, kind: "owner-op", title: kind, body: explanation?.slice(0, 300) || "" });
}

/** Token metadata for API consumers (symbol -> {address, decimals}). */
export { tokens, NATIVE, tokenByAddress, fromBaseUnits, AGENT_STATUS };
