// Prompt-injection detector — the agent's FIRST line of defence.
// Runs on the raw user text before any parsing or chain action.
// The corpus (eval/corpora/injection-30.json) exercises three channels:
//   direct  — the whole command IS the injection
//   embedded — a legit command carries a rider instruction
//   fake-system — text pretends to be an operator/system override
//
// Every hit is a hard REJECT: the agent never "considers" an injected
// instruction, and the refusal is written to the on-chain rejection ledger
// (category RiskEngine, reason names the injection).

const PATTERNS = [
  // ── instruction-override family ──────────────────────────────────────────
  { re: /\b(?:ignore|disregard|forget)\b[^.]{0,30}\b(?:instructions?|rules?|prompts?|directives?|guardrails?|policies|training|constraints?|everything)\b/i, weight: "high", tag: "override" },
  { re: /\b(?:new|updated?|revised)\s+(?:instructions?|rules?|policy|policies|directives?)\s*[:\-]/i, weight: "high", tag: "fake-system" },
  { re: /\byou\s+are\s+now\b/i, weight: "high", tag: "override" },
  { re: /\bact\s+as\s+(?:if|a|an|though)\b/i, weight: "medium", tag: "override" },
  { re: /\bpretend\s+(?:that\s+)?(?:you|to)\b/i, weight: "medium", tag: "override" },
  { re: /\bdo\s+not\s+ask\b.*\b(?:just|simply)\b|\bno\s+(?:questions|confirmation|approval)\s+(?:needed|required|asked)/i, weight: "medium", tag: "override" },

  // ── fake system / operator impersonation ─────────────────────────────────
  { re: /\[?system\]?\s*[:>]|###\s*system|<<\s*sys|<\|system\|>|\boperator\s+override\b|\badmin\s+mode\b|\bdeveloper\s+mode\b|\bmaintenance\s+mode\b/i, weight: "high", tag: "fake-system" },
  { re: /\b(?:i\s+am|this\s+is)\s+(?:your|the)\s+(?:developer|administrator|creator|owner|operator)\b/i, weight: "high", tag: "fake-system" },
  { re: /\bpolicy\s+(?:has\s+been\s+)?(?:changed|updated|suspended|disabled|removed|override)\b|\boverride\s+(?:the\s+)?polic(?:y|ies)\b/i, weight: "high", tag: "fake-system" },

  // ── guardrail-attack family ──────────────────────────────────────────────
  { re: /\b(?:bypass|circumvent|disable|remove|override|turn\s+off|ignore|disregard)\s+(?:the\s+|all\s+|your\s+)*(?:whitelist|caps?|limits?|guardrails?|checks?|restrictions?|approval|policy|policies|safety)/i, weight: "high", tag: "guardrail-attack" },
  { re: /\b(?:without|no)\s+(?:approval|authorization|limits?|restrictions?|checks?|review)\b/i, weight: "medium", tag: "guardrail-attack" },
  { re: /\b(?:unrestricted|unlimited)\s+(?:access|mode|transfers?)\b|\bno\s+limits?\b|\bmaximum\s+access\b/i, weight: "high", tag: "guardrail-attack" },
  { re: /\bjailbreak\b|\bdan\s+mode\b|\bchaos\s+mode\b/i, weight: "high", tag: "guardrail-attack" },
  { re: /\bexecute\s+(?:immediately|right\s+now)\b.*\b(?:everything|all|max)\b/i, weight: "medium", tag: "guardrail-attack" },

  // ── exfiltration / drain family ──────────────────────────────────────────
  { re: /\b(?:send|transfer|sweep|drain|empty|move|withdraw)\b[^.]{0,40}\b(?:everything|all\s+(?:of\s+)?(?:my\s+)?(?:funds?|money|balance)|(?:the|my|our|your)\s+(?:entire\s+)?(?:vault|balance)|max(?:imum)?\s+amount)\b/i, weight: "high", tag: "drain" },
  { re: /\b(?:reveal|share|print|expose|leak|send)\b[^.]{0,30}\b(?:private\s+key|seed\s+phrase|mnemonic|secret|credentials?|recovery\s+phrase)\b/i, weight: "high", tag: "exfiltration" },
];

/** Classify the channel of a detected injection (for the evidence ledger). */
function classifyChannel(text, hits) {
  const tags = new Set(hits.map((h) => h.tag));
  if (tags.has("fake-system")) return "fake-system-override";
  // a legit-looking action verb + an override rider => injection embedded in a command
  const hasAction = /\b(?:pay|send|sweep|move|transfer|swap|convert|rebalance)\b/i.test(text);
  const rider = /\b(?:also|then|after\s+that|additionally|;|and\s+then|while\s+you(?:'re| are)\s+at\s+it)\b/i.test(text);
  if (hasAction && (rider || hits.some((h) => h.tag === "override"))) return "embedded-in-rationale";
  return "direct-command";
}

/**
 * @returns {{detected: boolean, channel?: string, patterns: string[],
 *            reason?: string}}
 */
export function scanForInjection(text) {
  const hits = PATTERNS.filter((p) => p.re.test(text));
  if (hits.length === 0) return { detected: false, patterns: [] };
  const channel = classifyChannel(text, hits);
  const reason =
    `prompt injection suspected (${channel}): matched ` +
    hits.map((h) => `[${h.tag}]`).join(" ");
  return {
    detected: true,
    channel,
    patterns: hits.map((h) => h.tag),
    reason,
  };
}
