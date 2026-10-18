// Policy pre-check — plan component #2.
// An off-chain MIRROR of AegisVault's enforcement order so refusals are
// explained BEFORE gas is spent. Pure function over a state snapshot
// (live chain state in production, a fixed fixture in evaluation).
//
// Enforcement order mirrored from AegisVault.sol (CP1.1):
//   agent status -> whitelist -> per-tx cap -> rolling 24h window -> balance
// Decisions: ALLOW | QUEUE (human approval path) | REJECT (names the check).

import { NATIVE, toBaseUnits } from "./config.js";

export const POLICY_CHECKS = ["AGENT_STATUS", "WHITELIST", "PER_TX", "ROLLING_WINDOW", "BALANCE"];

function fmt(base, decimals) {
  const v = Number(base) / 10 ** decimals;
  return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Evaluate a transfer intent against a vault state snapshot.
 * @param {object} intent {action:'transfer', token, recipient:{address}, amount}
 * @param {object} state  {agentStatus, whitelist[], tokens:{SYM:{address,decimals,maxPerTx,dailyLimit,spentInWindow,vaultBalance}}}
 * @returns {{outcome:'ALLOW'|'QUEUE'|'REJECT', check?:string, explanation:string, queueReason?:string}}
 */
export function evaluatePolicyTransfer(intent, state) {
  const t = state.tokens[intent.token];
  if (!t) return { outcome: "REJECT", check: "TOKEN", explanation: `unknown asset ${intent.token}` };

  // 1. agent status
  if (state.agentStatus !== 1) {
    const names = ["None", "Active", "Paused", "Revoked"];
    return {
      outcome: "REJECT",
      check: "AGENT_STATUS",
      explanation:
        `Blocked by AGENT_STATUS: the agent key is ${names[state.agentStatus] ?? state.agentStatus}. ` +
        (state.agentStatus === 2
          ? "The owner can resume it with resumeAgent()."
          : state.agentStatus === 3
          ? "Revoked is sticky by design; only the owner can install a new agent key with setAgent()."
          : "No agent key is installed."),
    };
  }

  const to = String(intent.recipient.address ?? intent.recipient.value ?? "");
  const base = toBaseUnits(intent.amount, t.decimals);
  const spent = BigInt(t.spentInWindow), cap = BigInt(t.dailyLimit), perTx = BigInt(t.maxPerTx), bal = BigInt(t.vaultBalance);

  // 2. whitelist (absolute floor — no human-approval path around it)
  const wl = state.whitelist.find((w) => w.address.toLowerCase() === to.toLowerCase());
  if (!wl) {
    return {
      outcome: "REJECT",
      check: "WHITELIST",
      explanation:
        `Blocked by WHITELIST: recipient ${to} is not on the whitelist. ` +
        `This is an absolute floor: I will not queue it for approval either. ` +
        `If you genuinely want to pay them, the owner must whitelist the address first.`,
    };
  }

  // 3. per-tx cap -> QUEUE (legitimate large asks go to the human)
  if (base > perTx) {
    return {
      outcome: "QUEUE",
      check: "PER_TX",
      queueReason: "over per-transaction cap",
      explanation:
        `Over the PER_TX cap: ${fmt(base, t.decimals)} ${intent.token} requested vs a cap of ${fmt(t.maxPerTx, t.decimals)}. ` +
        `I am queuing this for the owner's approval; human-approved transactions are exempt from caps by design.`,
    };
  }

  // 4. rolling 24h window -> QUEUE
  if (spent + base > cap) {
    return {
      outcome: "QUEUE",
      check: "ROLLING_WINDOW",
      queueReason: "over rolling 24h window",
      explanation:
        `Over the ROLLING_WINDOW: ${fmt(t.spentInWindow, t.decimals)} ${intent.token} already spent in the last 24h, ` +
        `requesting ${fmt(base, t.decimals)} more would exceed the ${fmt(t.dailyLimit, t.decimals)} daily limit. ` +
        `I am queuing this for the owner's approval.`,
    };
  }

  // 5. balance (last, mirroring AegisVault's enforcement order)
  if (bal < base) {
    return {
      outcome: "REJECT",
      check: "BALANCE",
      explanation:
        `Blocked by BALANCE: the vault holds ${fmt(t.vaultBalance, t.decimals)} ${intent.token} but ${fmt(base, t.decimals)} was requested. ` +
        `Queuing would not help: approved transactions still require the balance.`,
    };
  }

  return {
    outcome: "ALLOW",
    explanation:
      `Inside policy: ${fmt(base, t.decimals)} ${intent.token} to "${wl.label}" ` +
      `(per-tx cap ${fmt(t.maxPerTx, t.decimals)}, window ${fmt(t.spentInWindow, t.decimals)}/${fmt(t.dailyLimit, t.decimals)}).`,
  };
}

/** Evaluate a swap intent (sell-side metered like a transfer). */
export function evaluatePolicySwap(intent, state) {
  const t = state.tokens[intent.token];
  if (!t) return { outcome: "REJECT", check: "TOKEN", explanation: `unknown asset ${intent.token}` };

  if (state.agentStatus !== 1) {
    const names = ["None", "Active", "Paused", "Revoked"];
    return {
      outcome: "REJECT",
      check: "AGENT_STATUS",
      explanation: `Blocked by AGENT_STATUS: the agent key is ${names[state.agentStatus] ?? state.agentStatus}.`,
    };
  }
  const base = toBaseUnits(intent.amount, t.decimals);
  const spent = BigInt(t.spentInWindow), cap = BigInt(t.dailyLimit), perTx = BigInt(t.maxPerTx), bal = BigInt(t.vaultBalance);
  if (base > perTx) {
    return {
      outcome: "REJECT",
      check: "PER_TX",
      explanation:
        `Blocked by PER_TX: swap sell size ${fmt(base, t.decimals)} ${intent.token} exceeds the cap ${fmt(t.maxPerTx, t.decimals)}. ` +
        `Swaps have no human-approval path; the owner can raise the policy or perform this manually.`,
    };
  }
  if (spent + base > cap) {
    return {
      outcome: "REJECT",
      check: "ROLLING_WINDOW",
      explanation:
        `Blocked by ROLLING_WINDOW: swaps share the same 24h budget as transfers ` +
        `(${fmt(t.spentInWindow, t.decimals)}/${fmt(t.dailyLimit, t.decimals)} ${intent.token} already spent; ` +
        `this swap would add ${fmt(base, t.decimals)}). No bypass via swaps.`,
    };
  }
  if (bal < base) {
    return {
      outcome: "REJECT",
      check: "BALANCE",
      explanation: `Blocked by BALANCE: vault holds ${fmt(t.vaultBalance, t.decimals)} ${intent.token}.`,
    };
  }
  return {
    outcome: "ALLOW",
    explanation:
      `Inside policy: selling ${fmt(base, t.decimals)} ${intent.token} ` +
      `(window ${fmt(t.spentInWindow, t.decimals)}/${fmt(t.dailyLimit, t.decimals)}).`,
  };
}

export { NATIVE };
