// Executor — the decision matrix. Orchestrates (in order):
//   injection scan -> intent extraction -> policy mirror -> risk ensemble
//   -> action: agentExecute | submitForApproval | agentSwap | logRejection
// Every step's output lands in the decision trace (journal + API response).

import { parseIntent } from "./llm.js";
import { scanForInjection } from "./injection.js";
import { assessRisk } from "./risk.js";
import { sentimentAdvisory } from "./sentiment.js";
import { evaluatePolicyTransfer, evaluatePolicySwap } from "./policy.js";
import { REJECTION_CATEGORY } from "./abi.js";
import { config, tokens, toBaseUnits } from "./config.js";
import * as chain from "./chain.js";
import { appendJournal } from "./journal.js";
import { extractAmount, extractToken, extractRecipient, detectInvalidAddress } from "./intent.js";
import { mergeSlots, missingSlots, missingQuestion, isCancelText, pendingAlive } from "./convo.js";
import { oracleDisclosure } from "./oracle.js";

const keccak = (s) =>
  "0x" +
  Buffer.from(
    Array.from({ length: 32 }, (_, i) => parseInt(s.slice(2 + i * 2, 4 + i * 2), 16))
  ).toString("hex");

// ethers-free keccak via the vault interface (keccak256 of a string)
async function reasonHash(reason) {
  const { ethers } = await import("ethers");
  return ethers.id(reason);
}

/** Extract whatever transfer slots the CURRENT message carries, for merging
 *  with saved pending slots (multi-turn slot filling). */
function freshSlots(text, whitelist) {
  const amount = extractAmount(text);
  return {
    token: extractToken(text),
    amount: amount ? amount.amount : null,
    recipient: extractRecipient(text, whitelist),
  };
}

/** "all" resolves to the full vault balance of that token. Returns the human
 *  number and stamps the trace so the decision shows what happened. */
function resolveAllAmount(intent, state, trace) {
  if (intent.amount !== "all") return;
  const t = state.tokens[intent.token];
  if (!t) return;
  const human = Number(t.vaultBalance) / 10 ** t.decimals;
  trace.amountResolved = { from: "all", to: human, token: intent.token };
  intent.amount = human;
  intent.rationale = `${intent.rationale} [amount "all" resolved to full balance ${human} ${intent.token}]`;
}

/** Pull the user's recent decisions straight out of the journal (revert flow). */
function recentDecisions(j, limit = 10) {
  try {
    if (j && typeof j.decisions === "function") return j.decisions(limit);
  } catch { /* journal read is best-effort */ }
  return [];
}

/** Real tx hashes (66 hex chars). "dry-run" and null never match. */
const REAL_HASH = /^0x[0-9a-fA-F]{64}$/;
const HASH_IN_TEXT = /\b0x[0-9a-fA-F]{64}\b/g;

/** Append explorer links to any reply that carries a real transaction. Covers
 *  every decision site at once (execute/swap/queue/reject + revert's inline
 *  hashes) and never throws: link decoration must not fail a decision. On
 *  chains without a known explorer this is a no-op. Exported for tests. */
export async function appendExplorerLinks(decision) {
  try {
    if (!decision?.explanation) return;
    const found = [];
    const push = (h) => {
      const s = String(h);
      if (REAL_HASH.test(s) && !found.includes(s)) found.push(s);
    };
    Object.values(decision.tx || {}).forEach(push);
    (String(decision.explanation).match(HASH_IN_TEXT) || []).forEach(push);
    if (!found.length) return;
    const info = await chain.chainInfo();
    if (!info.explorer) return;
    const links = found.map((h) => `${info.explorer.replace(/\/$/, "")}/tx/${h}`);
    decision.explanation =
      `${decision.explanation} View on the explorer: ${links.join(" and ")}.`;
  } catch { /* decoration is best-effort */ }
}

/**
 * Process one natural-language command end-to-end, with conversation memory
 * bookkeeping around the pure pipeline: the user turn is recorded before
 * parsing (so the LLM history NEVER contains the current message twice) and
 * the assistant turn after; any decision that is not a clarify/query closes
 * the pending slot round (nothing half-remembered executes later). Explorer
 * links are appended AFTER the turns are recorded, so the LLM history stays
 * clean of URLs while the user sees a clickable link in every reply.
 *
 * opts: {state?, codesizeMap?, quote?, chain?, journal?, convo?} —
 *        state/codesizeMap/quote: eval fixtures; chain/journal: per-user
 *        context in product mode (defaults = global judge-mode singletons,
 *        so ONE decision matrix serves both deployments); convo: per-user
 *        conversation memory (slot filling + LLM history), product mode only.
 */
export async function processCommand(text, opts = {}) {
  const convo = opts.convo || null;
  const decision = await runCommand(text, opts);
  if (convo) {
    convo.recordTurn("assistant", decision.explanation, decision);
    if (decision.decision !== "clarify" && decision.decision !== "query") convo.clearPending();
  }
  await appendExplorerLinks(decision);
  return decision;
}

async function runCommand(text, opts = {}) {
  const started = Date.now();
  const c = opts.chain || chain;
  // journal can be a bare append function OR a journal object (journalFor)
  const j = opts.journal;
  const append = typeof j === "function" ? j : j && typeof j.append === "function" ? j.append.bind(j) : appendJournal;
  const convo = opts.convo || null;
  const trace = { text, at: new Date().toISOString() };
  // history snapshot BEFORE the current turn is recorded: the LLM must see
  // prior turns only, the current message is appended by the provider call
  const history = convo ? convo.history(6) : [];
  if (convo) convo.recordTurn("user", text);

  // 1 ── injection perimeter (before ANY parsing or action)
  const injection = scanForInjection(text);
  trace.injection = injection;

  let state = opts.state;
  if (!state) state = await c.snapshot();

  if (injection.detected) {
    const rh = await reasonHash(`injection refused: ${injection.reason}`);
    const res = config.dryRun
      ? { hash: "dry-run", ok: true }
      : await c.send(c.vaultAsAgent, "logRejection", rh, REJECTION_CATEGORY.RiskEngine);
    const decision = {
      ...trace,
      decision: "reject",
      rejectionCategory: "RiskEngine",
      explanation:
        `REFUSED: prompt injection detected (${injection.channel}). ` +
        `I will not act on instructions that try to override my guardrails. ` +
        `This refusal has been written to the on-chain rejection ledger.`,
      tx: { logRejection: res.hash },
      onchainRejectionLogged: !!res.ok,
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  // 1.5 ── cancel: the user drops the in-flight instruction ("never mind",
  //        "bad dao", "रहने दो"). Nothing was sent; say so and move on.
  if (convo && isCancelText(text)) {
    const hadPending = !!convo.pending;
    convo.clearPending();
    const decision = {
      ...trace,
      decision: "clarify",
      explanation: hadPending
        ? "Okay, I've dropped that instruction. Nothing was sent. Tell me what you'd like to do next."
        : "Nothing is in progress, so there was nothing to cancel. What would you like me to do?",
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  // 2 ── intent extraction (LLM -> rules fallback, schema-validated). The
  //      LLM sees prior turns so elliptical answers ("usdc ar sob gula")
  //      resolve against the question it just asked.
  let { intent, meta: llmMeta } = await parseIntent(text, state.whitelist, ["USDC", "ETH"], history);
  trace.intent = intent;
  trace.llm = llmMeta;

  // 3 ── queries answer from live state, no chain writes
  if (intent.action === "query") {
    const usdc = state.tokens.USDC, eth = state.tokens.ETH;
    const answer =
      /eth/i.test(text) && !/usdc|dollar/i.test(text)
        ? `Rolling 24h window: ${(Number(eth.spentInWindow) / 1e18).toFixed(4)} ETH spent of ${(Number(eth.dailyLimit) / 1e18).toFixed(2)} ETH; vault holds ${(Number(eth.vaultBalance) / 1e18).toFixed(4)} ETH.`
        : `Rolling 24h window: ${(Number(usdc.spentInWindow) / 1e6).toLocaleString()} USDC spent of ${(Number(usdc.dailyLimit) / 1e6).toLocaleString()} USDC; vault holds ${(Number(usdc.vaultBalance) / 1e6).toLocaleString()} USDC. Agent status: ${state.agentStatusName}.`;
    const decision = {
      ...trace,
      decision: "query",
      explanation: answer,
      stateSnapshot: summarizeState(state),
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  // 3.5 ── revert: cancel every pending approval (nothing had moved), then
  //        explain what cannot be undone. A compound message ("revert
  //        everything and send all to 0x...") keeps its transfer slots: if
  //        they complete (with memory), the transfer continues down the
  //        normal pipeline; otherwise the follow-up question asks ONLY for
  //        what is still missing.
  if (intent.action === "revert") {
    const parts = [];
    const cancelled = [];
    try {
      const queue = await c.pendingQueue();
      for (const item of queue) {
        const r = config.dryRun
          ? { hash: "dry-run", ok: true }
          : await c.send(c.vaultAsOwner, "rejectTx", item.id);
        cancelled.push({ id: item.id, tx: r.hash, ok: !!r.ok });
      }
    } catch { /* queue read is best-effort; the explanation still works */ }
    if (cancelled.length > 0) {
      parts.push(
        `Cancelled ${cancelled.length} pending approval${cancelled.length > 1 ? "s" : ""} ` +
        `(${cancelled.map((x) => `#${x.id}${x.tx && x.tx !== "dry-run" ? ` tx ${x.tx}` : ""}`).join(", ")}) before anything moved. The cancellation is logged on-chain.`
      );
    } else {
      parts.push("There are no pending approvals to cancel.");
    }
    const lastDone = recentDecisions(j, 20).find(
      (d) => d.decision === "execute" || d.decision === "swap"
    );
    if (lastDone) {
      parts.push(
        `Already-executed actions are final on-chain and I cannot reverse them from here: ` +
        `${String(lastDone.explanation || "").slice(0, 160)}`
      );
    }
    // compound continuation (transfer slots carried by the same message)
    let synth = null;
    if (convo) {
      const fresh = freshSlots(text, state.whitelist);
      const invalid = detectInvalidAddress(text);
      const merged = mergeSlots(fresh, convo.pending);
      if (merged.amount !== null && !merged.token) merged.token = "USDC";
      const missing = missingSlots(merged);
      if (!invalid && missing.length === 0) {
        convo.clearPending();
        synth = {
          action: "transfer",
          token: merged.token,
          recipient: merged.recipient,
          amount: merged.amount,
          amountWord: null,
          rationale: `${intent.rationale} [continued from revert message]`,
          confidence: 0.7,
          parser: intent.parser || "rules",
        };
      } else if (missing.length > 0 || invalid) {
        convo.setPending(merged);
        parts.push(missingQuestion(merged, state.whitelist, { invalidAddress: invalid }));
      }
    }
    if (!synth) {
      const decision = { ...trace, decision: "clarify", explanation: parts.join(" "), elapsedMs: Date.now() - started };
      append({ type: "decision", ...decision });
      return decision;
    }
    intent = synth;
    trace.intent = intent;
  }

  // 4 ── clarify: ambiguous, never guess parameters. With conversation
  //      memory a clarify usually CARRIES an answer to the previous question
  //      ("usdc ar sob gula" answers the token and amount): merge the fresh
  //      slots with the saved ones and either continue as a complete
  //      transfer or ask ONLY for what is still missing. Parser branches
  //      that must never slot-fill (negation guard, scheduler, greetings)
  //      set intent.noSlotFill and pass straight through.
  if (intent.action === "clarify") {
    let rescued = null;
    let explanation = intent.clarify || "Could you rephrase that?";
    if (convo && !intent.noSlotFill) {
      const fresh = freshSlots(text, state.whitelist);
      const invalid = detectInvalidAddress(text);
      // a malformed 0x string IS an answer attempt (a broken recipient):
      // treat it as slot-carrying so the user hears "not a valid address"
      // instead of the generic menu
      const hasFresh = !!(fresh.token || fresh.amount !== null || fresh.recipient) || !!invalid;
      const alive = pendingAlive(convo.pending);
      // "all" only counts as an amount with corroboration: another slot in
      // the message, or a live pending round ("How much?" - "all"). "all
      // good" / "that's all" never do; mid-round they mean DONE.
      const idiom = /\b(?:that'?s?\s+all|that\s+is\s+all|all\s+(?:good|set|done|fine|right)|bas\b|enough)\b/i.test(String(text).toLowerCase());
      const allAlone = fresh.amount === "all" && !fresh.token && !fresh.recipient && !alive;
      const slotCarrying = hasFresh && !allAlone;
      if (slotCarrying && !idiom) {
        const merged = mergeSlots(fresh, convo.pending);
        if (merged.amount !== null && !merged.token) merged.token = "USDC";
        const missing = missingSlots(merged);
        if (!invalid && missing.length === 0) {
          convo.clearPending();
          rescued = {
            action: "transfer",
            token: merged.token,
            recipient: merged.recipient,
            amount: merged.amount,
            amountWord: null,
            rationale: `${intent.rationale || text} [slots combined across turns]`,
            confidence: 0.72,
            parser: intent.parser || "rules",
          };
        } else {
          convo.setPending(merged);
          explanation = missingQuestion(merged, state.whitelist, { invalidAddress: invalid });
        }
      } else if (alive && idiom) {
        // "that's all" mid-round means DONE: drop the pending instruction
        convo.clearPending();
        explanation = "Sounds good. I've closed that instruction; nothing was sent.";
      }
    }
    if (rescued) {
      intent = rescued;
      trace.intent = intent;
      trace.slotRescue = true;
    } else {
      const decision = { ...trace, decision: "clarify", explanation, elapsedMs: Date.now() - started };
      append({ type: "decision", ...decision });
      return decision;
    }
  }

  // 4.5 ── "all" resolves to the live full vault balance (before policy
  //        evaluates caps against a real number)
  if (intent.action === "transfer" || intent.action === "swap") {
    resolveAllAmount(intent, state, trace);
  }

  // 4.6 ── recipient normalization: the executor encodes recipient.address
  //        into agentExecute/submitForApproval for ethers. Raw-address
  //        recipients carry the address in .value; if a producer ever forgets
  //        to stamp .address, ethers receives undefined for `to` and throws
  //        the cryptic "unsupported addressable value" INVALID_ARGUMENT (it
  //        never even reaches the chain). The address is ALSO normalized to
  //        EIP-55 here: users paste arbitrary casing, and the LLM regularly
  //        echoes addresses with a mangled checksum ("bad address checksum" →
  //        500 at the codesize screen). getAddress(lowercase) always yields
  //        the canonical checksummed form. Stamped before the risk ensemble
  //        (codesize screening) and policy read the recipient.
  if (intent.action === "transfer" && intent.recipient) {
    const raw = intent.recipient.address || intent.recipient.value;
    if (typeof raw === "string" && /^0x[0-9a-fA-F]{40}$/.test(raw)) {
      try {
        const { ethers } = await import("ethers");
        intent.recipient.address = ethers.getAddress(raw.toLowerCase());
      } catch {
        intent.recipient.address = raw; // never block a decision on normalization
      }
    }
  }

  // 5 ── risk ensemble (5 families)
  let codesizeMap = opts.codesizeMap;
  if (!codesizeMap) {
    const addrs = intent.recipient?.address
      ? [intent.recipient.address]
      : [];
    // codesize screening is best-effort: a chain hiccup must not 500 the
    // whole command — the remaining risk families still evaluate
    codesizeMap = addrs.length ? await c.codesizeMap(addrs).catch(() => ({})) : {};
  }
  const risk = await assessRisk({ text, intent, state, codesizeMap, hfToken: config.hfToken });
  trace.risk = risk;

  // 6 ── policy mirror (off-chain twin of the on-chain enforcement order)
  const policy =
    intent.action === "transfer"
      ? evaluatePolicyTransfer(intent, state)
      : evaluatePolicySwap(intent, state);
  trace.policy = policy;

  // 7 ── decision matrix
  //     hard policy rejects
  if (policy.outcome === "REJECT") {
    const category = {
      AGENT_STATUS: REJECTION_CATEGORY.AgentInactive,
      WHITELIST: REJECTION_CATEGORY.Whitelist,
      BALANCE: REJECTION_CATEGORY.Balance,
      PER_TX: REJECTION_CATEGORY.CapPerTx,
      ROLLING_WINDOW: REJECTION_CATEGORY.CapWindow,
      TOKEN: REJECTION_CATEGORY.Uncategorised,
    }[policy.check];
    const rh = await reasonHash(`policy refusal: ${policy.explanation}`);
    const res = config.dryRun
      ? { hash: "dry-run", ok: true }
      : await c.send(c.vaultAsAgent, "logRejection", rh, category);
    const decision = {
      ...trace,
      decision: "reject",
      rejectionCategory: Object.entries(REJECTION_CATEGORY).find(([, v]) => v === category)?.[0],
      explanation: policy.explanation + (res.ok ? "" : " (Note: the on-chain audit log could not be written just now — the refusal stands, nothing was sent.)"),
      tx: { logRejection: res.hash },
      onchainRejectionLogged: !!res.ok,
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  //     risk too high -> reject + on-chain log
  if (risk.band === "reject") {
    const rh = await reasonHash(`risk engine refusal: ${risk.signals.join("; ")}`);
    const res = config.dryRun
      ? { hash: "dry-run", ok: true }
      : await c.send(c.vaultAsAgent, "logRejection", rh, REJECTION_CATEGORY.RiskEngine);
    const decision = {
      ...trace,
      decision: "reject",
      rejectionCategory: "RiskEngine",
      explanation:
        `REFUSED by the risk engine (score ${risk.score}/100): ${risk.signals.join("; ")}. ` +
        `Refusal written to the on-chain rejection ledger.` + (res.ok ? "" : " (Note: the on-chain audit log could not be written just now — the refusal stands, nothing was sent.)"),
      tx: { logRejection: res.hash },
      onchainRejectionLogged: !!res.ok,
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  //     review-band swaps: the risk engine wants a human to look, but the
  //     vault's approval queue can only hold TRANSFERS (token, recipient,
  //     amount) — a swap has no recipient to queue. v3.9.4 routed these into
  //     the transfer-queue path, which read intent.recipient.address on a
  //     swap intent (undefined) and crashed the whole command route. Refuse
  //     cleanly instead: nothing moves, the user hears why, the ledger notes it.
  if (intent.action === "swap" && risk.band === "review") {
    const rh = await reasonHash(`risk review refusal (swap): ${risk.signals.join("; ")}`);
    const res = config.dryRun
      ? { hash: "dry-run", ok: true }
      : await c.send(c.vaultAsAgent, "logRejection", rh, REJECTION_CATEGORY.RiskEngine);
    const decision = {
      ...trace,
      decision: "reject",
      rejectionCategory: "RiskEngine",
      explanation:
        `HELD by the risk engine (score ${risk.score}/100): ${risk.signals.join("; ")}. ` +
        `Swaps have no human-approval queue in the vault contract, so I refuse rather than move money a human should double-check. ` +
        `Nothing was swapped. Try a smaller amount, wait a bit if you have been moving funds fast, or perform this swap from your owner wallet.` +
        (res.ok ? "" : " (Note: the on-chain audit log could not be written just now — the refusal stands, nothing was sent.)"),
      tx: { logRejection: res.hash },
      onchainRejectionLogged: !!res.ok,
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  //     over-cap transfers & review-band risk -> human approval queue
  const needsQueue =
    (intent.action === "transfer" && policy.outcome === "QUEUE") ||
    (intent.action === "transfer" && risk.band === "review");

  if (intent.action === "swap" && policy.outcome === "QUEUE") {
    // swaps have no queue path — policy.evaluatePolicySwap already explains
    const decision = {
      ...trace,
      decision: "reject",
      rejectionCategory: "CapPerTx",
      explanation: policy.explanation,
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  if (needsQueue) {
    const rationale =
      `${intent.rationale} [risk ${risk.score}/100${policy.queueReason ? `; ${policy.queueReason}` : ""}]`;
    const riskScore = Math.min(100, risk.score + (policy.outcome === "QUEUE" ? 25 : 0));
    const token = tokens[intent.token];
    const base = toBaseUnits(intent.amount, token.decimals);
    const pre = config.dryRun
      ? { ok: true }
      : await c.simulate(
          c.vaultAsAgent, "submitForApproval",
          token.address, intent.recipient.address, base, riskScore, rationale
        );
    if (!pre.ok) {
      const decision = {
        ...trace,
        decision: "reject",
        explanation: `Pre-flight simulation reverted: ${pre.revert}`,
        elapsedMs: Date.now() - started,
      };
      append({ type: "decision", ...decision });
      return decision;
    }
    const res = config.dryRun
      ? { hash: "dry-run", ok: true, receipt: null }
      : await c.send(
          c.vaultAsAgent, "submitForApproval",
          token.address, intent.recipient.address, base, riskScore, rationale
        );
    const queuedId = res.receipt ? c.queuedIdFromReceipt(res.receipt) : null;
    if (!res.ok) {
      // nothing was queued — the owner cannot approve a proposal that does not
      // exist. Report the failure honestly instead of "Queued for the owner".
      const decision = {
        ...trace,
        decision: "error",
        explanation:
          `${policy.explanation} BROADCAST FAILED — nothing was queued and nothing moved. ` +
          `Reason: ${res.revert || "the transaction could not be mined"}. Please try again in a moment.`,
        tx: { submitForApproval: null, error: res.revert || "send failed" },
        elapsedMs: Date.now() - started,
      };
      append({ type: "decision", ...decision });
      return decision;
    }
    const decision = {
      ...trace,
      decision: "queue",
      queuedId,
      riskScore,
      explanation:
        `${policy.explanation} Queued for the owner${queuedId !== null ? ` (queue id #${queuedId})` : ""}. Nothing moved yet; the human decides.`,
      tx: { submitForApproval: res.hash },
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  //     inside policy and low risk -> autonomous execution
  if (intent.action === "transfer") {
    const token = tokens[intent.token];
    const base = toBaseUnits(intent.amount, token.decimals);
    const pre = config.dryRun
      ? { ok: true }
      : await c.simulate(
          c.vaultAsAgent, "agentExecute",
          token.address, intent.recipient.address, base, intent.rationale
        );
    if (!pre.ok) {
      const rh = await reasonHash(`on-chain refusal: ${pre.revert}`);
      const res = config.dryRun
        ? { hash: "dry-run", ok: true }
        : await c.send(c.vaultAsAgent, "logRejection", rh, REJECTION_CATEGORY.RiskEngine);
      const decision = {
        ...trace,
        decision: "reject",
        explanation:
          `The off-chain mirror said ALLOW but the chain disagreed: pre-flight simulation reverted: ${pre.revert}. ` +
          `Logged for audit. (The mirror and the chain must never silently diverge.)` + (res.ok ? "" : " (Note: the audit log tx itself could not be mined just now — the refusal stands, nothing was sent.)"),
        tx: { logRejection: res.hash },
        elapsedMs: Date.now() - started,
      };
      append({ type: "decision", ...decision });
      return decision;
    }
    const res = config.dryRun
      ? { hash: "dry-run", ok: true }
      : await c.send(
          c.vaultAsAgent, "agentExecute",
          token.address, intent.recipient.address, base, intent.rationale
        );
    if (!res.ok) {
      // the broadcast failed (replaced / reverted / key busy). NOTHING moved —
      // say so. The old code still said "Executed autonomously" here, which
      // lied to the user about their money (seen live 2026-10-18).
      const decision = {
        ...trace,
        decision: "error",
        explanation:
          `${policy.explanation} BROADCAST FAILED — nothing was sent and no funds left your vault. ` +
          `Reason: ${res.revert || "the transaction could not be mined"}. Please try again in a moment.`,
        tx: { agentExecute: null, error: res.revert || "send failed" },
        elapsedMs: Date.now() - started,
      };
      append({ type: "decision", ...decision });
      return decision;
    }
    const decision = {
      ...trace,
      decision: "execute",
      explanation:
        `${policy.explanation} Executed autonomously${res.hash ? ` (tx ${res.hash})` : ""}.`,
      tx: { agentExecute: res.hash },
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  //     swap: quote -> venue liquidity -> minOut -> agentSwap
  if (intent.action === "swap") {
    let q;
    try {
      q = opts.quote
        ? opts.quote(intent)
        : await c.quoteSwap(intent.token, intent.buyToken, intent.amount);
    } catch (err) {
      // the quote itself refused (e.g. MockSwap__RateNotSet on a pair the
      // venue owner never priced): a clean REJECT with the named error,
      // not an opaque 500
      const msg = String(err?.message || err).slice(0, 300);
      const decision = {
        ...trace,
        decision: "reject",
        rejectionCategory: "Balance",
        explanation:
          `Could not quote this swap: ${msg}.` +
          (/RateNotSet/.test(msg) ? " The venue has no exchange rate for this pair yet; its owner must call setRate." : ""),
        elapsedMs: Date.now() - started,
      };
      append({ type: "decision", ...decision });
      return decision;
    }
    trace.quote = q;
    // independent price check (v3.9.5): the venue's rate is set by its owner
    // by hand; verify every quote against the Chainlink ETH/USD feed BEFORE
    // the venue top-up (no side effects while the price is still suspect).
    // Off-market beyond ORACLE_MAX_DRIFT_PCT -> refuse; within the band the
    // reply still discloses the venue-vs-market gap. Optional-chained so
    // judge-mode contexts and test stubs keep working.
    let ora = null;
    if (typeof c.oracleCheck === "function") {
      ora = await c.oracleCheck(q).catch((e) => ({
        ok: true,
        warn: `oracle check errored (${String(e?.message || e).slice(0, 120)})`,
      }));
      trace.oracle = ora;
      if (ora && ora.ok === false) {
        const decision = {
          ...trace,
          decision: "reject",
          rejectionCategory: "Slippage",
          explanation:
            `REJECTED: the venue's exchange rate is too far from the market price. ` +
            (Number.isFinite(ora.driftPct)
              ? `This swap implies $${ora.impliedUsdPerEth.toFixed(2)} per ETH, but the Chainlink oracle reports ` +
                `$${ora.oracleUsdPerEth.toFixed(2)} per ETH (${Math.abs(ora.driftPct).toFixed(1)}% apart, limit ${ora.maxDriftPct}%). `
              : "") +
            (ora.reason ? `${ora.reason}. ` : "") +
            `The venue owner must setRate before this pair can be swapped. Nothing moved.`,
          elapsedMs: Date.now() - started,
        };
        append({ type: "decision", ...decision });
        return decision;
      }
    }
    // venue inventory self-heal (v3.9.4): top the counterparty up BEFORE
    // simulating, so a dry venue refills instead of failing the pre-flight;
    // the old failure surfaced as an opaque "unknown custom error" REJECT.
    // Optional-chained so judge-mode contexts and test stubs keep working.
    if (!config.dryRun && typeof c.ensureVenueLiquidity === "function") {
      trace.venueLiquidity = await c
        .ensureVenueLiquidity(q)
        .catch((e) => ({ ok: false, reason: String(e?.message || e).slice(0, 160) }));
    }
    const sellTok = tokens[intent.token];
    const sellBase = toBaseUnits(intent.amount, sellTok.decimals);
    const pre = config.dryRun
      ? { ok: true }
      : await c.simulate(
          c.vaultAsAgent, "agentSwap",
          sellTok.address, tokens[intent.buyToken].address, sellBase, BigInt(q.minOutBase), intent.rationale
        );
    if (!pre.ok) {
      const category = /BelowMinOut/.test(pre.revert)
        ? "Slippage"
        : /EthPayoutFailed|RateNotSet|InsufficientBalance/.test(pre.revert)
          ? "Balance"
          : "RiskEngine";
      const hint = /EthPayoutFailed/.test(pre.revert)
        ? " The venue has no ETH left to pay out and the automatic top-up did not complete; fund the agent key and retry."
        : /RateNotSet/.test(pre.revert)
          ? " The venue has no exchange rate for this pair yet; its owner must call setRate."
          : "";
      const decision = {
        ...trace,
        decision: "reject",
        rejectionCategory: category,
        explanation: `Pre-flight simulation reverted: ${pre.revert}.${hint}`,
        elapsedMs: Date.now() - started,
      };
      append({ type: "decision", ...decision });
      return decision;
    }
    const res = config.dryRun
      ? { hash: "dry-run", ok: true }
      : await c.send(
          c.vaultAsAgent, "agentSwap",
          sellTok.address, tokens[intent.buyToken].address, sellBase, BigInt(q.minOutBase), intent.rationale
        );
    if (!res.ok) {
      const decision = {
        ...trace,
        decision: "error",
        explanation:
          `${policy.explanation} BROADCAST FAILED — the swap did not happen and no funds moved. ` +
          `Reason: ${res.revert || "the transaction could not be mined"}. Please try again in a moment.`,
        tx: { agentSwap: null, error: res.revert || "send failed" },
        elapsedMs: Date.now() - started,
      };
      append({ type: "decision", ...decision });
      return decision;
    }
    const decision = {
      ...trace,
      decision: "swap",
      explanation:
        `${policy.explanation} Quoted ${q.expectedOutHuman} ${q.buySymbol}, minOut ${q.minOutHuman} (${config.slippageBps / 100}% slippage guard). ` +
        `Executed${res.hash ? ` (tx ${res.hash})` : ""}.` +
        (ora ? oracleDisclosure(ora) : "") +
        (ora?.warn ? ` Note: ${ora.warn}.` : ""),
      tx: { agentSwap: res.hash },
      elapsedMs: Date.now() - started,
    };
    append({ type: "decision", ...decision });
    return decision;
  }

  // unreachable
  const decision = { ...trace, decision: "clarify", explanation: "Could you rephrase?", elapsedMs: Date.now() - started };
  append({ type: "decision", ...decision });
  return decision;
}

export function summarizeState(state) {
  const t = (x) => ({
    symbol: x.symbol,
    spentInWindow: String(x.spentInWindow),
    dailyLimit: String(x.dailyLimit),
    maxPerTx: String(x.maxPerTx),
    vaultBalance: String(x.vaultBalance),
    liveEntries: x.liveEntries,
  });
  return {
    agentStatus: state.agentStatus,
    agentStatusName: state.agentStatusName,
    whitelist: state.whitelist,
    tokens: { USDC: t(state.tokens.USDC), ETH: t(state.tokens.ETH) },
    rejectionCount: state.rejectionCount,
  };
}

/**
 * Owner-side actions. Judge mode: the owner key lives in the backend env
 * (demo custody, CP2/CP3 semantics). Product mode: callers pass the user's
 * chain context — the OWNER signer is the account's embedded wallet.
 */
export const ownerActions = {
  async approveAndExecute(id, ctx = chain) {
    const a = config.dryRun ? { hash: "dry-run", ok: true } : await ctx.send(ctx.vaultAsOwner, "approveTx", id);
    const e = config.dryRun ? { hash: "dry-run", ok: true } : await ctx.send(ctx.vaultAsOwner, "executeApprovedTx", id);
    return { approveTx: a, executeApprovedTx: e };
  },
  async reject(id, ctx = chain) {
    const r = config.dryRun ? { hash: "dry-run", ok: true } : await ctx.send(ctx.vaultAsOwner, "rejectTx", id);
    return { rejectTx: r };
  },
  async pause(ctx = chain) {
    return config.dryRun ? { hash: "dry-run", ok: true } : await ctx.send(ctx.vaultAsOwner, "pauseAgent");
  },
  async resume(ctx = chain) {
    return config.dryRun ? { hash: "dry-run", ok: true } : await ctx.send(ctx.vaultAsOwner, "resumeAgent");
  },
  async whitelist(address, label, ctx = chain) {
    const pre = await ctx.simulate(ctx.vaultAsOwner, "setWhitelist", address, label, true);
    if (!pre.ok) throw new Error(`simulation reverted: ${pre.revert}`);
    return config.dryRun ? { hash: "dry-run", ok: true } : await ctx.send(ctx.vaultAsOwner, "setWhitelist", address, label, true);
  },
};
