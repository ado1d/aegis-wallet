#!/usr/bin/env node
// Aegis agent — evidence pack generator (7-class taxonomy, PRD Table 16).
//
// Reads a vault's event log from the chain, classifies every event, merges
// manual entries (a deliberately-reverted tx emits no event, so it lives in
// manual-entries.json), and emits an Etherscan-linked markdown pack + JSON.
//
//   npm run evidence                                # uses the .env vault
//   npm run evidence -- --vault 0x…                 # a per-user vault (product mode)
//   npm run evidence -- --from-block 11947000       # bound the log range
//   npm run evidence -- --explorer https://sepolia.etherscan.io --label sepolia
//
// RPC notes: public relays cap eth_getLogs ranges (publicnode 50,000 blocks,
// Alchemy free tier 10 blocks). Point --from-block just below the vault's
// deploy block and the query stays inside every relay's budget.
//
// Exit code 0 = every class meets its minimum AND ≥15 unique tx hashes
// (the submission gate). Exit 1 = pack not yet submission-ready.
//
// Manual entries file (default docs/evidence/manual-entries.json):
//   [ { "txHash": "0x…", "classId": "C4", "note": "…", "block": 123 } ]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ethers } from "ethers";
import { config } from "./src/config.js";
import { provider, vault } from "./src/chain.js";
import { VAULT_ABI } from "./src/abi.js";

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const OUT_DIR = resolve(flag("out", "docs/evidence"));
const FROM_BLOCK = Number(flag("from-block", 0));
const EXPLORER = flag("explorer", null); // e.g. https://sepolia.etherscan.io
const LABEL = flag("label", null); // e.g. "sepolia"; default from chainId
const MANUAL = resolve(flag("manual", join(OUT_DIR, "manual-entries.json")));
const NO_GATE = args.includes("--no-gate");
// per-user vaults (product mode): --vault 0x… overrides the .env vault so any
// user's vault can be harvested; falls back to the .env vault (judge mode).
const TARGET = (() => {
  const a = flag("vault", null);
  if (!a) return vault;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { console.error(`--vault must be 0x + 40 hex: ${a}`); process.exit(2); }
  return new ethers.Contract(a, VAULT_ABI, provider);
})();

// ── taxonomy (PRD Table 16 — minimum counts per class) ─────────────────────
const TAXONOMY = [
  { id: "C1", need: 3, title: "L1 transfer execution (agent key alone, inside guardrails)", events: ["AgentExecuted"] },
  { id: "C2", need: 2, title: "Rebalancing swap via MockSwap (slippage floor enforced)", events: ["AgentSwapped"] },
  { id: "C3", need: 2, title: "On-chain rejection (logRejection ledger)", events: ["RejectionLogged"] },
  { id: "C4", need: 1, title: "Deliberately reverted transaction (direct call, manual gas limit)", events: [] },
  { id: "C5", need: 3, title: "Approval round trip (queue → approve → execute)", events: ["TxQueued", "TxApproved", "ApprovedTxExecuted"] },
  { id: "C6", need: 2, title: "Kill switch (pause + resume)", events: ["AgentPaused", "AgentResumed"] },
  { id: "C7", need: 2, title: "Policy / whitelist configuration (on-chain policy state)", events: ["VaultDeployed", "TokenPolicyUpdated", "WhitelistUpdated", "SwapVenueUpdated", "AgentUpdated"] },
];
const HASH_TARGET = 15;

const REJECT_CATEGORY = ["Uncategorised", "CapPerTx", "CapWindow", "Whitelist", "AgentInactive", "OwnerRejected", "RiskEngine", "Slippage", "Balance"];

// ── formatting helpers ──────────────────────────────────────────────────────
const USDC = (config.usdc || "").toLowerCase();
const isEth = (t) => !t || t === "0x0000000000000000000000000000000000000000";
const fmt = (amount, token) => {
  try {
    const a = BigInt(amount);
    if (isEth(token)) return `${Number(a) / 1e18} ETH`;
    if (String(token).toLowerCase() === USDC) return `${Number(a) / 1e6} USDC`;
    return a.toString();
  } catch { return String(amount); }
};
const sym = (token) => (isEth(token) ? "ETH" : String(token).toLowerCase() === USDC ? "USDC" : `${String(token).slice(0, 8)}…`);
const short = (a) => `${String(a).slice(0, 10)}…${String(a).slice(-6)}`;

function describe(name, ev) {
  const a = ev.args ?? ev;
  switch (name) {
    case "AgentExecuted":
      return `execute ${fmt(a.amount, a.token)} → ${short(a.to)} · "${a.reason}" · window after: ${fmt(a.spentInWindow, a.token)}`;
    case "AgentSwapped":
      return `swap ${fmt(a.sellAmount, a.sellToken)} → ${fmt(a.outAmount, a.buyToken)} (minOut ${fmt(a.minOut, a.buyToken)} enforced) · "${a.reason}"`;
    case "RejectionLogged":
      return `rejection ledger entry · category ${REJECT_CATEGORY[Number(a.category)] ?? a.category} · actor ${short(a.actor)}`;
    case "TxQueued":
      return `queue proposal #${a.id}: ${fmt(a.amount, a.token)} → ${short(a.to)} (risk score ${a.riskScore}) · "${a.reason}"`;
    case "TxApproved":
      return `owner approves proposal #${a.id}: ${fmt(a.amount, a.token)} → ${short(a.to)} (human-in-the-loop)`;
    case "ApprovedTxExecuted":
      return `executed approved proposal #${a.id}: ${fmt(a.amount, a.token)} → ${short(a.to)} (exempt from caps by design)`;
    case "TxRejected":
      return `owner rejects proposal #${a.id}`;
    case "AgentPaused":
      return `kill switch: agent PAUSED by owner — every agent action now refuses on-chain`;
    case "AgentResumed":
      return `kill switch: agent RESUMED by owner — autonomy restored`;
    case "AgentRevoked":
      return `kill switch: agent REVOKED permanently (sticky)`;
    case "VaultDeployed":
      return `vault deployed · owner ${short(a.owner)} · agent ${short(a.agent)}`;
    case "TokenPolicyUpdated":
      return `policy ${sym(a.token)}: per-tx cap ${fmt(a.oldMaxPerTx, a.token)} → ${fmt(a.newMaxPerTx, a.token)}, rolling-24h window ${fmt(a.oldDailyLimit, a.token)} → ${fmt(a.newDailyLimit, a.token)}`;
    case "WhitelistUpdated":
      return `whitelist ${a.allowed ? "ADD" : "REMOVE"}: ${short(a.who)} "${a.label}"`;
    case "SwapVenueUpdated":
      return `swap venue set → ${short(a.newVenue)}`;
    case "AgentUpdated":
      return `agent key rotated: ${short(a.oldAgent)} → ${short(a.newAgent)}`;
    case "OwnerWithdrawal":
      return `owner sovereign withdrawal: ${fmt(a.amount, a.token)} → ${short(a.to)} (no agent limits apply)`;
    case "Deposited":
      return `deposit into vault: ${fmt(a.amount, a.token)} from ${short(a.from)}`;
    default:
      return name;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!config.vault) {
    console.error("VAULT_ADDRESS not set — copy .env.example to .env first.");
    process.exit(2);
  }

  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const latest = await provider.getBlockNumber();
  const label = LABEL ?? (chainId === 11155111 ? "sepolia" : chainId === 31337 ? "anvil" : `chain-${chainId}`);
  const explorer = EXPLORER ?? (chainId === 11155111 ? "https://sepolia.etherscan.io" : null);
  const link = (h) => (explorer ? `[${h.slice(0, 12)}…${h.slice(-8)}](${explorer}/tx/${h})` : `\`${h.slice(0, 12)}…${h.slice(-8)}\``);

  console.log(`harvesting events · ${label} (chainId ${chainId}) · vault ${config.vault} · blocks ${FROM_BLOCK}–${latest}`);

  // collect every taxonomy event
  const rows = []; // {classId, txHash, block, ts, text}
  const eventNames = [...new Set(TAXONOMY.flatMap((t) => t.events))].concat(["TxRejected", "AgentRevoked", "OwnerWithdrawal", "Deposited"]);
  const blockTsCache = new Map();
  const tsOf = async (b) => {
    if (!blockTsCache.has(b)) {
      const blk = await provider.getBlock(b);
      blockTsCache.set(b, blk ? new Date(blk.timestamp * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC") : "?");
    }
    return blockTsCache.get(b);
  };

  for (const name of eventNames) {
    let logs = [];
    try {
      logs = await TARGET.queryFilter(name, FROM_BLOCK, latest);
    } catch (e) {
      console.error(`  [warn] queryFilter(${name}) failed: ${e.message}`);
      continue;
    }
    for (const log of logs) {
      const cls = TAXONOMY.find((t) => t.events.includes(name));
      const classified = cls
        ? { classId: cls.id }
        : name === "TxRejected" || name === "AgentRevoked"
          ? { classId: "C6" }
          : name === "OwnerWithdrawal" || name === "Deposited"
            ? { classId: "C7" }
            : { classId: null };
      if (!classified.classId) continue;
      let text;
      try { text = describe(name, log); } catch { text = name; }
      rows.push({ classId: classified.classId, event: name, txHash: log.transactionHash, block: log.blockNumber, ts: await tsOf(log.blockNumber), text });
    }
  }

  // manual entries (deliberately-reverted tx etc.)
  if (existsSync(MANUAL)) {
    try {
      const entries = JSON.parse(readFileSync(MANUAL, "utf8"));
      for (const m of entries) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(m.txHash ?? "")) { console.error(`  [warn] manual entry has invalid txHash — skipped`); continue; }
        const cls = TAXONOMY.find((t) => t.id === (m.classId ?? "C4"));
        if (!cls) { console.error(`  [warn] manual entry classId "${m.classId}" unknown — skipped`); continue; }
        rows.push({ classId: cls.id, event: "manual", txHash: m.txHash, block: m.block ?? "?", ts: m.ts ?? "?", text: m.note ?? "" });
      }
    } catch (e) { console.error(`  [warn] could not parse ${MANUAL}: ${e.message}`); }
  }

  // per-class grouping + gate
  const byClass = Object.fromEntries(TAXONOMY.map((t) => [t.id, rows.filter((r) => r.classId === t.id).sort((a, b) => (a.block === "?" ? 0 : a.block) - (b.block === "?" ? 0 : b.block))]));
  const uniqueHashes = new Set(rows.map((r) => r.txHash)).size;
  const perClassOk = TAXONOMY.every((t) => byClass[t.id].length >= t.need);
  const gateOk = perClassOk && uniqueHashes >= HASH_TARGET;

  // markdown
  const md = [];
  md.push(`# Aegis Wallet — on-chain evidence pack (${label})`);
  md.push("");
  md.push(`Vault \`${config.vault}\` · chainId **${chainId}** · blocks ${FROM_BLOCK}–${latest} · generated ${new Date().toISOString()}`);
  md.push(`Regenerate any time: \`node harvest-evidence.mjs\` — this pack is read from chain state and cannot drift.`);
  md.push("");
  md.push(`| Class | Evidence | Have / need | Status |`);
  md.push(`|---|---|---|---|`);
  for (const t of TAXONOMY) {
    const have = byClass[t.id].length;
    md.push(`| **${t.id}** ${t.title} | ${have} | ${have} / ${t.need} | ${have >= t.need ? "PASS" : "MISSING"} |`);
  }
  md.push(`| **Total unique tx hashes** | ${uniqueHashes} | ${uniqueHashes} / ${HASH_TARGET} | ${uniqueHashes >= HASH_TARGET ? "PASS" : "MISSING"} |`);
  md.push("");
  md.push(`**Submission gate: ${gateOk ? "PASS — pack is submission-ready" : "NOT READY — collect the missing classes above"}**`);
  md.push("");
  for (const t of TAXONOMY) {
    if (!byClass[t.id].length) continue;
    md.push(`## ${t.id} — ${t.title} (${byClass[t.id].length}/${t.need})`);
    md.push("");
    md.push(`| Tx | Block | Time | What it proves |`);
    md.push(`|---|---|---|---|`);
    for (const r of byClass[t.id]) md.push(`| ${link(r.txHash)} | ${r.block} | ${r.ts} | ${r.text} |`);
    md.push("");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = join(OUT_DIR, `evidence-${label}.md`);
  const jsonPath = join(OUT_DIR, `evidence-${label}.json`);
  writeFileSync(mdPath, md.join("\n") + "\n");
  writeFileSync(jsonPath, JSON.stringify({ chainId, label, vault: config.vault, fromBlock: FROM_BLOCK, latestBlock: latest, generatedAt: new Date().toISOString(), explorer, uniqueHashes, gate: { perClassOk, hashesOk: uniqueHashes >= HASH_TARGET, ok: gateOk }, classes: TAXONOMY.map((t) => ({ ...t, rows: byClass[t.id] })) }, null, 2) + "\n");

  console.log(md.slice(4, 4 + TAXONOMY.length + 3).join("\n"));
  console.log(`\nwrote ${mdPath}`);
  console.log(`wrote ${jsonPath}`);
  if (!NO_GATE) {
    console.log(`\nEVIDENCE GATE: ${gateOk ? "PASS" : "FAIL"} (unique hashes ${uniqueHashes}/${HASH_TARGET})`);
    process.exit(gateOk ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
