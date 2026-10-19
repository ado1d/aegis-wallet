// Chain layer — plan component #4 (the agent driver).
// ethers v6: JsonRpcProvider, per-role wallets, NonceManager, static-call
// pre-flight with custom-error decoding, and an event poller that appends
// every vault event to the audit journal.

import { ethers } from "ethers";
import { VAULT_ABI, ERC20_ABI, VENUE_ABI, AGENT_STATUS } from "./abi.js";
import { config, tokens, NATIVE, tokenByAddress, toBaseUnits } from "./config.js";
import { appendJournal } from "./journal.js";
import { getStore } from "./store.js";
import { ethUsdPrice, venueRateSanity } from "./oracle.js";

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

// Product mode runs with VAULT_ADDRESS empty (per-user vaults are deployed at
// signup). ethers treats "" as an ENS name and throws at import time, so the
// judge-mode singleton is parked at the zero address instead: it is never
// CALLED in product mode (the event poller returns early on empty config.vault
// and every product path goes through per-user contexts).
export const vault = new ethers.Contract(config.vault || ethers.ZeroAddress, VAULT_ABI, provider);
export const venue = config.venue ? new ethers.Contract(config.venue, VENUE_ABI, provider) : null;
export const vaultAsAgent = agentWallet ? vault.connect(agentWallet) : null;
export const vaultAsOwner = ownerWallet ? vault.connect(ownerWallet) : null;

// decode interfaces for the swap-venue and plain ERC-20 error surfaces
// (OpenZeppelin v5 custom errors bubble up through the vault's and the
// venue's token calls, e.g. the venue failing to pay out USDC it does not
// hold). Standalone rather than tied to the configured contracts so decoding
// works the same in tests and when an address is not configured yet.
const venueIface = new ethers.Interface(VENUE_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

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
  return withKeyLease(wallet, async (nonce) => {
    try {
      const tx = await wallet.sendTransaction({
        to,
        value: ethers.parseEther(String(amountEth)),
        ...(nonce != null ? { nonce } : {}),
      });
      const rc = await tx.wait();
      return { hash: rc.hash, ok: rc.status === 1 };
    } catch (err) {
      return { hash: null, ok: false, revert: explainRevert(err) };
    }
  });
}

// ── chain identity (explorer links etc.) ────────────────────────────────────
let _chainInfo = null;
export async function chainInfo() {
  if (_chainInfo) return _chainInfo;
  try {
    const net = await provider.getNetwork();
    const explorers = {
      11155111n: "https://sepolia.etherscan.io",
      1n: "https://etherscan.io",
      80002n: "https://amoy.polygonscan.com",
    };
    const names = {
      11155111n: "sepolia",
      31337n: "anvil (local)",
      80002n: "amoy (testnet)",
      1n: "ethereum mainnet",
    };
    _chainInfo = {
      chainId: Number(net.chainId),
      name: names[net.chainId] || `chain ${net.chainId}`,
      explorer: config.explorerUrl || explorers[net.chainId] || "",
    };
  } catch {
    _chainInfo = { chainId: 0, name: "unreachable", explorer: config.explorerUrl || "" };
  }
  return _chainInfo;
}

/** Explorer URL for a tx hash (null when no explorer is known, or the value is
 *  not a real 32-byte hash — "dry-run" never linkifies). Used by the executor
 *  to append a clickable link to every reply that carries a transaction. */
export async function txLink(hash) {
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(String(hash))) return null;
  const info = await chainInfo();
  return info.explorer ? `${info.explorer.replace(/\/$/, "")}/tx/${hash}` : null;
}

/** Wait bound for the request-path self-heal. Anvil mines instantly (30s is
 *  generous); live testnets need one block per tx and a full re-provision is
 *  6+ transactions, so 180s. An explicit PROVISION_TIMEOUT_MS always wins. */
export async function provisionBoundMs() {
  if (config.provisionTimeoutMs > 0) return config.provisionTimeoutMs;
  const info = await chainInfo();
  return info.chainId === 31337 ? 30_000 : 180_000;
}

/** Map an ethers revert into a human-readable custom-error string. */
export function explainRevert(err) {
  const data =
    err?.info?.error?.data ||
    err?.data ||
    (typeof err?.shortMessage === "string" && err.shortMessage.includes("reverted") ? err.shortMessage : null);
  if (data && typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    // try every interface the agent knows — the vault, then the swap venue
    // (venue reverts bubble up through the vault's agentSwap call, e.g.
    // MockSwap__EthPayoutFailed when the venue's ETH inventory ran dry), then
    // the ERC-20 error surface. All of this used to surface as an opaque
    // "unknown custom error".
    for (const iface of [vault?.interface, venueIface, erc20Iface].filter(Boolean)) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          const args = parsed.args.map((a) => (typeof a === "bigint" ? ethers.formatUnits(a, 0) : String(a)));
          return `${parsed.name}(${args.join(", ")})`;
        }
      } catch { /* try the next interface */ }
    }
    // no known interface matched: keep the 4-byte selector visible so the
    // revert stays traceable instead of a bare "unknown custom error"
    return `unknown custom error ${data.slice(0, 10)} (data ${data.slice(0, 74)}${data.length > 74 ? "..." : ""})`;
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

/** Broadcast and wait; returns {hash, block, ok, revert?}.
 *
 *  Every send is serialized PER SIGNING KEY through a cross-instance lease
 *  (store-backed when Postgres is configured, per-process otherwise) and
 *  carries a nonce fetched FRESH under that lease. Rationale: on serverless
 *  hosting several instances share one agent key while each owns a private
 *  in-memory NonceManager — concurrent broadcasts collide, transactions get
 *  replaced, and callers used to record phantom "executed" decisions. The
 *  lease + fresh nonce makes every broadcast deterministic. */
export async function send(contract, method, ...args) {
  if (config.dryRun) return { hash: null, block: null, ok: true, dryRun: true };
  return withKeyLease(contract?.runner, async (nonce) => {
    try {
      const tx = await contract[method](...args, ...(nonce != null ? [{ nonce }] : []));
      const rc = await tx.wait();
      return { hash: rc.hash, block: rc.blockNumber, ok: rc.status === 1, receipt: rc };
    } catch (err) {
      return { hash: null, block: null, ok: false, revert: explainRevert(err) };
    }
  });
}

// ── per-key send serialization ─────────────────────────────────────────────
const HOLDER = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** Run `fn` while holding the lease for the wallet's address. When the store
 *  is Postgres the lease is shared by EVERY instance (the fix for serverless
 *  nonce collisions); with the in-memory store it still serializes threads
 *  inside this process. Best effort: if the store is unreachable the send
 *  proceeds WITHOUT the lease rather than failing the user's command. */
async function withKeyLease(wallet, fn) {
  let addr = null;
  try {
    if (wallet && typeof wallet.getAddress === "function") addr = await wallet.getAddress();
  } catch { /* non-signer runner — nothing to serialize */ }
  if (!addr) return fn();

  const store = getStore();
  if (typeof store?.acquireLease !== "function") return fn();
  const lease = await store
    .acquireLease(`tx:${addr.toLowerCase()}`, HOLDER, 150_000, 75_000)
    .catch(() => ({ ok: false, degraded: true }));
  if (!lease?.ok) {
    // lease unavailable: either genuinely busy or the store hiccuped. Fail
    // CLOSED with a retryable message — the executor surfaces it honestly
    // and nothing is recorded as executed.
    return {
      hash: null, block: null, ok: false,
      revert: "the sending key is busy with another in-flight transaction — try again in a few seconds",
    };
  }
  try {
    // fresh nonce under the lease: correct even if OTHER instances sent txs
    // since this one's NonceManager was last used
    let nonce = null;
    try { nonce = await provider.getTransactionCount(addr, "pending"); } catch { /* fall back to manager */ }
    return await fn(nonce);
  } finally {
    try { await lease.release(); } catch { /* expired — fine */ }
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
  let outBase;
  try {
    outBase = await venue.quote(sell.address, buy.address, sellBase);
  } catch (err) {
    // a quote revert is a real answer (e.g. MockSwap__RateNotSet on a pair
    // the venue owner never priced) — surface the named error instead of an
    // opaque 500
    throw new Error(`the venue refused to quote this pair: ${explainRevert(err)}`);
  }
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

// ── swap-venue inventory self-heal ──────────────────────────────────────────
// MockSwap is the counterparty: it pays every buy-side payout from its OWN
// balance, so USDC->ETH swaps drain its ETH and ETH->USDC swaps drain its
// USDC. The deploy script seeds the venue once (0.1 ETH); a long-lived
// testnet deployment runs dry and every later swap reverts with
// MockSwap__EthPayoutFailed — the failure users saw as an opaque
// "unknown custom error" REJECT. The agent key holds the operational pot,
// so it refills the venue the same way it funds user stipends: automatically,
// capped, idempotent, and never at the cost of its own gas money.

/** Pure top-up decision for the venue's ETH inventory (plain ETH units).
 *  Exported for the test suite; the chain-touching wrapper is below. */
export function venueTopUpPlan(venueEth, agentEth, payoutEth = 0) {
  const min = Math.max(0, config.venueEthMin); // buffer the venue must always keep
  const target = Math.max(min, config.venueEthTarget); // refill level
  const reserve = Math.max(0, config.venueGasReserveEth); // the agent key keeps its gas money
  const need = payoutEth > 0 ? payoutEth + min : min; // this payout must clear plus buffer
  if (venueEth >= need) return { action: "none" };
  const shortfall = need - venueEth; // minimum that must arrive for this swap
  const refill = Math.max(0, target - venueEth); // refill to the standing level
  const afford = agentEth - reserve; // never spend the gas reserve
  // a payout no affordable refill can cover: even sending everything the
  // agent key can spare leaves the venue short of this payout plus its
  // buffer. v3.9.4 sent a partial top-up anyway and let the simulation fail
  // with a misleading "fund the agent key" hint — name the real problem.
  if (payoutEth > 0 && venueEth + Math.max(0, afford) < need) {
    return {
      action: "too-large",
      payoutEth,
      need,
      canReachEth: venueEth + Math.max(0, afford),
      reason:
        `this swap pays out ${payoutEth.toFixed(4)} ETH (plus the ${min.toFixed(4)} ETH venue buffer), ` +
        `but the venue can hold at most ${(venueEth + Math.max(0, afford)).toFixed(4)} ETH ` +
        `(${venueEth.toFixed(4)} ETH held + what the agent key can spare)`,
    };
  }
  const amount = Math.min(Math.max(refill, shortfall), afford);
  if (!(amount > 0)) {
    return {
      action: "cant",
      reason:
        `the venue holds ${venueEth.toFixed(4)} ETH but ${need.toFixed(4)} ETH is needed, ` +
        `and the agent key can spare ${Math.max(0, afford).toFixed(4)} ETH after its gas reserve`,
    };
  }
  return { action: "send", amountEth: amount };
}

/** Keep the shared swap venue payable. Called at boot (standing inventory)
 *  and before every swap with the live quote, so a dry venue refills instead
 *  of failing the pre-flight. Best effort: a failure here never blocks the
 *  swap; the simulation then reports the named revert. */
export async function ensureVenueLiquidity(q = null) {
  if (!venue) return { ok: true, skipped: "no venue configured" };
  if (config.dryRun) return { ok: true, skipped: "dry-run" };
  if (!agentWallet) return { ok: false, reason: "AGENT_KEY not configured" };
  try {
    const venueAddr = await venue.getAddress();
    if (!q || q.buySymbol === "ETH") {
      const payoutEth = q ? Number(q.expectedOutHuman) || 0 : 0;
      const [venueBal, agentBal] = await Promise.all([
        provider.getBalance(venueAddr),
        agentWallet.getAddress().then((a) => provider.getBalance(a)),
      ]);
      const plan = venueTopUpPlan(
        Number(ethers.formatEther(venueBal)),
        Number(ethers.formatEther(agentBal)),
        payoutEth
      );
      if (plan.action === "none") return { ok: true };
      if (plan.action === "too-large") {
        // no affordable refill can cover this payout: the executor refuses
        // BEFORE any top-up broadcast (a partial send could never fix it)
        return { ok: false, tooLarge: true, reason: plan.reason, payoutEth: plan.payoutEth, canReachEth: plan.canReachEth };
      }
      if (plan.action === "cant") return { ok: false, reason: plan.reason };
      const r = await sendEthFrom(agentWallet, venueAddr, plan.amountEth);
      if (!r.ok) return { ok: false, reason: `venue ETH top-up failed: ${r.revert || r.hash}` };
      console.log(`  [venue] topped up ${plan.amountEth.toFixed(4)} ETH (tx ${r.hash})`);
      return { ok: true, toppedUpEth: plan.amountEth, tx: r.hash };
    }
    if (q.buySymbol === "USDC" && config.usdc) {
      // ERC-20 buy side: the venue pays USDC from its own inventory. The
      // mock asset's mint is an open testnet faucet, so refill it in place.
      const dec = tokens.USDC.decimals;
      const venueBal = await erc20(config.usdc).balanceOf(venueAddr);
      const needBase = toBaseUnits(q.expectedOutHuman, dec);
      const minBase = toBaseUnits(config.venueUsdcMin, dec);
      if (venueBal >= needBase + minBase) return { ok: true };
      const targetBase = toBaseUnits(config.venueUsdcTarget, dec);
      const mintBase = targetBase > venueBal ? targetBase - venueBal : needBase + minBase - venueBal;
      if (mintBase <= 0n) return { ok: true };
      const r = await mintMockUsdcFrom(agentWallet, venueAddr, mintBase);
      if (!r.ok) return { ok: false, reason: `venue USDC refill failed: ${r.revert || r.hash}` };
      const human = Number(mintBase) / 10 ** dec;
      console.log(`  [venue] minted ${human.toLocaleString()} USDC into the venue (tx ${r.hash})`);
      return { ok: true, mintedUsdc: human, tx: r.hash };
    }
    return { ok: true, skipped: "pair needs no inventory" };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 200) };
  }
}

// ── independent swap-price verification (v3.9.5) ────────────────────────────
// The venue's rate is owner-set; this cross-checks every quote against the
// Chainlink ETH/USD feed. Called by the executor AFTER a successful quote and
// BEFORE the venue top-up (no side effects while the price is still suspect).
// Returns { ok:false, ... } ONLY when the swap must be refused; degraded
// oracle states (missing feed / stale / unreachable) warn unless strict.

/** Raw feed state for /health (no verdict, just what the oracle says). */
export async function oracleStatus() {
  return ethUsdPrice(provider);
}

export async function oracleCheck(q) {
  const o = await ethUsdPrice(provider);
  if (o.skipped) return { ok: true, skipped: o.skipped };
  if (o.error) {
    if (config.oracleStrict) {
      return { ok: false, verdict: "unreachable", reason: `the Chainlink oracle could not be read (${o.error}) and ORACLE_STRICT is on` };
    }
    return { ok: true, warn: `oracle unreachable (${o.error}) — price check skipped` };
  }
  if (o.stale) {
    if (config.oracleStrict) {
      return { ok: false, verdict: "stale", reason: `the Chainlink oracle answer is ${o.ageHrs}h old (limit ${config.oracleMaxAgeHrs}h) and ORACLE_STRICT is on` };
    }
    return { ok: true, warn: `oracle answer is ${o.ageHrs}h old — price check skipped`, priceUsd: o.priceUsd };
  }
  const s = venueRateSanity(q, o.priceUsd);
  return { ...s, feed: o.feed, updatedAt: o.updatedAt };
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
