// Chain layer — plan component #4 (the agent driver).
// ethers v6: JsonRpcProvider, per-role wallets, NonceManager, static-call
// pre-flight with custom-error decoding, and an event poller that appends
// every vault event to the audit journal.

import { ethers } from "ethers";
import { VAULT_ABI, ERC20_ABI, VENUE_ABI, AGENT_STATUS } from "./abi.js";
import { config, tokens, NATIVE, tokenByAddress, toBaseUnits } from "./config.js";
import { appendJournal } from "./journal.js";

const provider = new ethers.JsonRpcProvider(config.rpcUrl);
const ownerWallet = config.ownerKey
  ? new ethers.NonceManager(new ethers.Wallet(config.ownerKey, provider))
  : null;
const agentWallet = config.agentKey
  ? new ethers.NonceManager(new ethers.Wallet(config.agentKey, provider))
  : null;

/** Drop cached nonces after a chain reset. NonceManagers track the next nonce
 *  in memory; if the chain underneath was wiped (anvil restart) the cached
 *  value points into the future and every subsequent tx sits in the mempool
 *  waiting for a nonce that never comes — tx.wait() hangs forever. reset()
 *  makes the manager re-fetch the nonce from the network on the next send.
 *  Only called with chain-reset evidence (see provision.healStaleVaults and
 *  uservault.userChainContext), never while healthy txs are in flight. */
export async function resetNonceManagers() {
  const wallets = [ownerWallet, agentWallet].filter(Boolean);
  await Promise.all(wallets.map((w) => (typeof w.reset === "function" ? w.reset() : Promise.resolve())));
}

export const vault = new ethers.Contract(config.vault, VAULT_ABI, provider);
export const venue = config.venue ? new ethers.Contract(config.venue, VENUE_ABI, provider) : null;
export const vaultAsAgent = agentWallet ? vault.connect(agentWallet) : null;
export const vaultAsOwner = ownerWallet ? vault.connect(ownerWallet) : null;

const erc20Cache = {};
export function erc20(address) {
  const a = address.toLowerCase();
  if (!erc20Cache[a]) erc20Cache[a] = new ethers.Contract(address, ERC20_ABI, provider);
  return erc20Cache[a];
}

// ── Demo faucet (CP3 hosted-judge quickstart) ───────────────────────────────
// MockUSDC.mint is intentionally open (demo asset); the guard rails — per
// address cooldown + global daily cap — live in src/faucet.js, and this is
// the only path the agent uses to mint. Shares the owner NonceManager.
const MINT_ABI = ["function mint(address to, uint256 amount)"];

/** Mint mock USDC from any funded wallet (judge: owner key, product: agent key). */
export async function mintMockUsdcFrom(wallet, to, baseAmount) {
  if (!config.usdc) return { ok: false, revert: "USDC_ADDRESS not configured" };
  if (!wallet) return { ok: false, revert: "no funded wallet configured" };
  const mint = new ethers.Contract(config.usdc, MINT_ABI, wallet);
  return send(mint, "mint", to, baseAmount);
}

export function mintMockUsdc(to, baseAmount) {
  return mintMockUsdcFrom(ownerWallet, to, baseAmount);
}

/** Plain native-ETH transfer from any wallet (provisioner seeding). */
export async function sendEthFrom(wallet, to, amountEth) {
  if (config.dryRun) return { hash: "dry-run", ok: true };
  try {
    const tx = await wallet.sendTransaction({ to, value: ethers.parseEther(String(amountEth)) });
    const rc = await tx.wait();
    return { hash: rc.hash, ok: rc.status === 1 };
  } catch (err) {
    return { hash: null, ok: false, revert: explainRevert(err) };
  }
}

// ── chain identity (explorer links etc.) ────────────────────────────────────
let _chainInfo = null;
export async function chainInfo() {
  if (_chainInfo) return _chainInfo;
  try {
    const net = await provider.getNetwork();
    const explorers = { 11155111n: "https://sepolia.etherscan.io", 1n: "https://etherscan.io" };
    _chainInfo = {
      chainId: Number(net.chainId),
      name: net.chainId === 11155111n ? "sepolia" : net.chainId === 31337n ? "anvil (local)" : `chain ${net.chainId}`,
      explorer: explorers[net.chainId] || "",
    };
  } catch {
    _chainInfo = { chainId: 0, name: "unreachable", explorer: "" };
  }
  return _chainInfo;
}

/** Map an ethers revert into a human-readable custom-error string. */
export function explainRevert(err) {
  const data =
    err?.info?.error?.data ||
    err?.data ||
    (typeof err?.shortMessage === "string" && err.shortMessage.includes("reverted") ? err.shortMessage : null);
  if (data && typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const parsed = vault.interface.parseError(data);
      if (parsed) {
        const args = parsed.args.map((a) => (typeof a === "bigint" ? ethers.formatUnits(a, 0) : String(a)));
        return `${parsed.name}(${args.join(", ")})`;
      }
    } catch { /* fall through */ }
  }
  return err?.shortMessage || err?.reason || String(err?.message || err).slice(0, 200);
}

/** Pre-flight: simulate a call, return {ok:true} or {ok:false, revert}. */
export async function simulate(contract, method, ...args) {
  try {
    await contract[method].staticCall(...args);
    return { ok: true };
  } catch (err) {
    return { ok: false, revert: explainRevert(err) };
  }
}

/** Broadcast and wait; returns {hash, block, ok, revert?}. */
export async function send(contract, method, ...args) {
  if (config.dryRun) return { hash: null, block: null, ok: true, dryRun: true };
  try {
    const tx = await contract[method](...args);
    const rc = await tx.wait();
    return { hash: rc.hash, block: rc.blockNumber, ok: rc.status === 1, receipt: rc };
  } catch (err) {
    return { hash: null, block: null, ok: false, revert: explainRevert(err) };
  }
}

/** Extract the queued-tx id from a submitForApproval receipt (TxQueued topic). */
export function queuedIdFromReceipt(receipt) {
  if (!receipt?.logs) return null;
  const iface = vault.interface;
  for (const log of receipt.logs) {
    try {
      const ev = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (ev && ev.name === "TxQueued") return Number(ev.args.id);
    } catch { /* not ours */ }
  }
  return null;
}

// ── state snapshot (the policy mirror's live input) ──────────────────────────
// Parameterized around a vault contract so judge mode (global vault) and
// product mode (per-user vaults) share one implementation.

async function tokenState(vault, symbol, meta) {
  const vaultAddr = await vault.getAddress();
  const [policy, spent, win] = await Promise.all([
    vault.getPolicy(meta.address),
    vault.spentInWindow(meta.address),
    vault.windowState(meta.address),
  ]);
  let vaultBalance;
  if (meta.address === NATIVE) vaultBalance = await provider.getBalance(vaultAddr);
  else vaultBalance = await erc20(meta.address).balanceOf(vaultAddr);
  return {
    symbol,
    address: meta.address,
    decimals: meta.decimals,
    maxPerTx: policy[0],
    dailyLimit: policy[1],
    spentInWindow: spent,
    liveEntries: Number(win[0]),
    capacity: Number(win[1]),
    vaultBalance,
  };
}

export async function snapshotOf(vault, history) {
  const [status, wlAddrs, rejections] = await Promise.all([
    vault.agentStatus(),
    vault.getWhitelist(),
    vault.rejectionCount(),
  ]);
  const whitelist = [];
  for (const a of wlAddrs) {
    whitelist.push({ address: a, label: await vault.whitelistLabel(a) });
  }
  const [usdcState, ethState] = await Promise.all([
    tokenState(vault, "USDC", tokens.USDC),
    tokenState(vault, "ETH", tokens.ETH),
  ]);
  return {
    agentStatus: Number(status),
    agentStatusName: AGENT_STATUS[Number(status)],
    whitelist,
    tokens: { USDC: usdcState, ETH: ethState },
    rejectionCount: Number(rejections),
    history: history || (await recentSpends()),
  };
}

export async function snapshot() {
  return snapshotOf(vault);
}

/** Recent agent spends (for the amount-anomaly family), from the journal. */
async function recentSpends() {
  try {
    const { readJournal } = await import("./journal.js");
    return recentSpendsFrom(readJournal());
  } catch {
    return [];
  }
}

/** Same computation over any journal's entries (per-user journals included). */
export function recentSpendsFrom(entries) {
  return (entries || [])
    .filter((e) => e.type === "decision" && e.decision === "execute" && e.intent?.token)
    .slice(-10)
    .map((e) => ({ token: e.intent.token, amount: Math.round(e.intent.amount * 10 ** (e.intent.token === "ETH" ? 18 : 6)) }));
}

/** Bytecode map for the codesize risk family (contract-vs-EOA screening). */
export async function codesizeMap(addresses) {
  const map = {};
  await Promise.all(
    addresses.map(async (a) => {
      map[a.toLowerCase()] = await provider.getCode(a);
    })
  );
  return map;
}

// ── queue + rejection views (parameterized per vault) ──────────────────────

export async function pendingQueueOf(vault) {
  const len = Number(await vault.queueLength());
  const out = [];
  for (let id = 1; id <= len; id++) {
    const tx = await vault.getTx(id);
    if (Number(tx.status) === 0 || Number(tx.status) === 1) {
      out.push({
        id,
        token: tokenByAddress(tx.token)?.symbol || tx.token,
        tokenAddress: tx.token,
        to: tx.to,
        amount: tx.amount.toString(),
        proposedBy: tx.proposedBy,
        riskScore: Number(tx.riskScore),
        reason: tx.reason,
        createdAt: Number(tx.createdAt),
        status: ["Queued", "Approved", "Rejected", "Executed"][Number(tx.status)],
      });
    }
  }
  return out;
}

export async function pendingQueue() {
  return pendingQueueOf(vault);
}

export async function rejectionsOf(vault, limit = 20) {
  const count = Number(await vault.rejectionCount());
  const out = [];
  for (let i = Math.max(0, count - limit); i < count; i++) {
    const r = await vault.getRejection(i);
    out.push({
      index: i,
      actor: r.actor,
      reasonHash: r.reasonHash,
      category: Number(r.category),
      at: Number(r.at),
    });
  }
  return out.reverse();
}

export async function rejections(limit = 20) {
  return rejectionsOf(vault, limit);
}

// ── swap quote ──────────────────────────────────────────────────────────────

export async function quoteSwap(sellSymbol, buySymbol, amountHuman) {
  if (!venue) throw new Error("VENUE_ADDRESS not configured");
  const sell = tokens[sellSymbol], buy = tokens[buySymbol];
  if (!sell || !buy) throw new Error("unknown token pair");
  const sellBase = toBaseUnits(amountHuman, sell.decimals);
  const outBase = await venue.quote(sell.address, buy.address, sellBase);
  // slippage feeds BigInt() — clamp a bad config value to the default instead
  // of crashing the swap path with BigInt(NaN)
  const bps =
    Number.isFinite(config.slippageBps) && config.slippageBps >= 0 && config.slippageBps < 10000
      ? Math.round(config.slippageBps)
      : 150;
  const minOut = (outBase * BigInt(10000 - bps)) / 10000n;
  return {
    sellSymbol, buySymbol, sellAmountHuman: amountHuman,
    expectedOutHuman: Number(outBase) / 10 ** buy.decimals,
    minOutHuman: Number(minOut) / 10 ** buy.decimals,
    minOutBase: minOut.toString(),
    slippageBps: bps,
  };
}

// ── event poller (on-chain audit trail) ─────────────────────────────────────

let lastPolledBlock = null;
export async function pollEventsOnce() {
  if (!config.vault) return;
  let current;
  try {
    current = await provider.getBlockNumber();
  } catch {
    // chain unreachable (anvil down or still starting) — never crash the
    // agent over the audit poller; retry silently on the next tick
    return;
  }
  if (lastPolledBlock === null) { lastPolledBlock = current; return; }
  if (current <= lastPolledBlock) return;
  const from = lastPolledBlock + 1;
  lastPolledBlock = current;
  const events = ["AgentExecuted", "AgentSwapped", "TxQueued", "TxApproved", "TxRejected", "ApprovedTxExecuted", "RejectionLogged", "AgentPaused", "AgentResumed", "AgentRevoked", "WhitelistUpdated"];
  for (const name of events) {
    try {
      const logs = await vault.queryFilter(name, from, current);
      for (const log of logs) {
        const ev = log.fragment ? log : vault.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (ev) {
          await appendJournal({
            type: "onchain-event",
            at: new Date().toISOString(),
            block: log.blockNumber,
            event: name,
            args: Object.fromEntries(
              ev.fragment.inputs.map((i) => [i.name, String(ev.args[i.name])])
            ),
          });
        }
      }
    } catch { /* keep polling */ }
  }
}

export function startEventPoller(intervalMs = 6000) {
  // .catch on every launch — a dead RPC must never take the API down
  pollEventsOnce().catch(() => {});
  return setInterval(() => pollEventsOnce().catch(() => {}), intervalMs);
}

export { provider, ownerWallet, agentWallet };
