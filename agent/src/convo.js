// Per-user conversation memory (product mode).
//
// The parser is stateless BY DESIGN (one text in, one intent out) — that is
// what keeps eval deterministic and audit traces honest. But a real chat has
// follow-up turns: the agent asks "which token?", the user answers "usdc ar
// sob gula", and the agent must COMBINE the two instead of asking again.
//
// This module holds, per user id:
//   turns   — the last few chat turns (fed to the LLM as message history so
//             ellipsis answers like "sob usdc" are understood in context)
//   pending — half-filled transfer slots from a clarify round (token, amount,
//             recipient), with a TTL so stale questions never execute later
//
// SECURITY INVARIANT: pending slots only ever FILL a transfer intent that the
// current message itself triggers or continues. The current message must
// still parse (verb, or an answer to the pending question); nothing executes
// from memory alone. Every executed/queued/rejected decision clears pending.

const MEMORIES = new Map();

const TTL_MS = 5 * 60 * 1000; // a clarify round older than 5 min is void
const MAX_TURNS = 12; // kept per user; LLM gets the last few only

// ── cancel words: the user drops the in-flight instruction ─────────────────
// Deliberately unambiguous phrases only. "thik ache" / "theek hai" ("okay")
// are EXCLUDED: said after a question they can mean "yes, go ahead".
const CANCEL_LATIN =
  /\b(?:never\s?mind|nevermind|forget\s?it|drop\s?it|leave\s?it|cancel\s?(?:it|that|this)?|kotha\s?holo\s?na|bad\s?(?:dao|dio|den|dilen)|lagbe\s?na|dorkar\s?nei|ar\s?na|nahi\s?chahiye|rehne\s?do|chodo|mat\s?karo)\b/i;
const CANCEL_SCRIPT = /(?:বাতিল|না\s?লাগবে|দরকার\s?নেই|बातिल|छोड़ो|रहने\s?दो|取消|取り消し|취소|إلغاء|الغاء)/;

export function isCancelText(text) {
  const s = String(text || "");
  return CANCEL_LATIN.test(s) || CANCEL_SCRIPT.test(s);
}

// ── slot helpers ─────────────────────────────────────────────────────────────

/** Merge freshly extracted slots with saved pending slots.
 *  Fresh values win; "all" is a real value, not a placeholder. */
export function mergeSlots(fresh, pending) {
  const p = pendingAlive(pending) ? pending : null;
  return {
    token: fresh.token || p?.token || null,
    amount: fresh.amount ?? p?.amount ?? null,
    recipient: fresh.recipient || p?.recipient || null,
  };
}

export function pendingAlive(pending) {
  return !!pending && Date.now() - pending.at < TTL_MS;
}

/** Human phrase for what we already know ("all USDC", "50 USDC"). */
export function slotPhrase(merged) {
  const amt = merged.amount === "all" ? "all" : merged.amount;
  return [amt, merged.token].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
}

/** Which transfer slots are still missing? */
export function missingSlots(merged) {
  const missing = [];
  if (!merged.token) missing.push("token");
  if (merged.amount === null || merged.amount === undefined) missing.push("amount");
  if (!merged.recipient) missing.push("recipient");
  return missing;
}

/** The contextual follow-up question: ask ONLY for what is still missing,
 *  and confirm what we already hold. `invalidAddress` (from the current
 *  message) takes priority: a malformed 0x string must be called out so the
 *  user stops pasting the same broken value. */
export function missingQuestion(merged, whitelist, { invalidAddress = null } = {}) {
  const labels = (whitelist || []).map((w) => w.label).join(", ");
  const known = slotPhrase(merged);
  if (invalidAddress) {
    return (
      `"${invalidAddress}" is not a valid address. An address is 0x followed by exactly 40 ` +
      `hex characters (0-9, a-f). Please paste the full address, or name a payee${labels ? ` (${labels})` : ""}.`
    );
  }
  const missing = missingSlots(merged);
  if (missing.length === 1 && missing[0] === "recipient") {
    return (
      `Got it: ${known}. Who should receive it? ` +
      `Name a payee${labels ? ` (${labels})` : ""} or paste a 0x address.`
    );
  }
  if (missing.length === 1 && missing[0] === "amount") {
    const to = merged.recipient?.label || merged.recipient?.value || "them";
    return `How much ${merged.token || ""} should I send to ${to}? Give a number, or say "all" for the full vault balance.`;
  }
  if (missing.length === 1 && missing[0] === "token") {
    return `Which asset should I use, USDC or ETH?`;
  }
  const need = missing
    .map((m) => (m === "token" ? "which asset (USDC or ETH)" : m === "amount" ? "how much (a number or \"all\")" : "who receives it (a payee or a 0x address)"))
    .join(" and ");
  return `Almost there${known ? `; I have ${known}` : ""}. Still need: ${need}.`;
}

// ── the per-user memory object ───────────────────────────────────────────────

function makeConvo() {
  return {
    turns: [],
    pending: null,

    /** Save half-filled slots from a clarify round (fresh values overwrite). */
    setPending(slots) {
      const p = pendingAlive(this.pending) ? this.pending : {};
      this.pending = {
        token: slots.token || p.token || null,
        amount: slots.amount ?? p.amount ?? null,
        recipient: slots.recipient || p.recipient || null,
        at: Date.now(),
      };
    },
    clearPending() {
      this.pending = null;
    },

    /** One chat turn. `decision` is the decision object (or null pre-parse). */
    recordTurn(role, text, decision = null) {
      this.turns.push({
        role,
        text: String(text || "").slice(0, 500),
        decision: decision
          ? { kind: decision.decision, explanation: String(decision.explanation || "").slice(0, 300) }
          : null,
        at: Date.now(),
      });
      if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
    },

    /** LLM message history (most recent last), excluding the current turn. */
    history(maxMessages = 6) {
      return this.turns.slice(-maxMessages).map((t) => ({
        role: t.role,
        content: t.text,
      }));
    },

    /** The user's most recent non-clarify decision, for the revert flow. */
    lastMeaningfulDecision() {
      for (let i = this.turns.length - 1; i >= 0; i--) {
        const d = this.turns[i]?.decision;
        if (d && d.kind && d.kind !== "clarify") return d;
      }
      return null;
    },
  };
}

/** The conversation memory bound to one user id (product mode). */
export function convoFor(userId) {
  let c = MEMORIES.get(userId);
  if (!c) {
    c = makeConvo();
    MEMORIES.set(userId, c);
  }
  return c;
}

// test/eval isolation
export function _resetMemories() {
  MEMORIES.clear();
}
