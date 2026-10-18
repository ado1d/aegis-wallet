// Conversation-memory regression tests (v3.7 feature set).
// Phase A: a multi-turn transcript replayed through processCommand with a
//          per-user convo (rules mode, dry-run, fixture state): every turn
//          must build on the previous one instead of re-asking.
// Phase B: LLM history threading against a mock OpenAI-compatible server.
// Phase C: safety guards (idioms, cancel, negation, fresh-command isolation).
// Usage: npm run test:convo   (from agent/, no chain and no LLM key needed)
process.env.LLM_PROVIDER = "rules";
process.env.RPC_URL = "http://127.0.0.1:8545";

// Importing the executor pulls in the live chain module, and ethers probes
// the RPC in the background even though this suite only ever uses fixture
// state. Without anvil that probe rejects with ECONNREFUSED; swallow exactly
// that noise source so real failures still fail the test loudly.
process.on("unhandledRejection", (err) => {
  if (String(err?.message || err).includes("ECONNREFUSED")) return;
  console.error("unhandled rejection:", err);
  process.exit(1);
});

const { readFileSync } = await import("node:fs");
const { resolve } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const { config } = await import(`${ROOT}/src/config.js`);
config.dryRun = true;

const { processCommand } = await import(`${ROOT}/src/executor.js`);
const { convoFor, _resetMemories, isCancelText, mergeSlots, missingSlots } = await import(`${ROOT}/src/convo.js`);
const { parseIntentRules, extractAmount, detectInvalidAddress } = await import(`${ROOT}/src/intent.js`);

const fixture = JSON.parse(readFileSync(resolve(ROOT, "eval/fixture-state.json"), "utf8"));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

// stub chain: fixture state passed explicitly; pendingQueue empty; dry-run sends
const stubChain = {
  pendingQueue: async () => [],
  codesizeMap: async () => ({}),
  send: async () => ({ hash: "dry-run", ok: true, receipt: null }),
  simulate: async () => ({ ok: true }),
  quoteSwap: async () => ({ minOutBase: "1", expectedOutHuman: "1", minOutHuman: "1", buySymbol: "ETH" }),
};
const fakeJournal = {
  append() {},
  decisions() { return []; },
};

const WL = fixture.whitelist;
const USDC_BAL = Number(fixture.tokens.USDC.vaultBalance) / 1e6;

async function say(convo, text) {
  return processCommand(text, { state: fixture, codesizeMap: {}, chain: stubChain, journal: fakeJournal, convo });
}

// ── Phase A: the user's exact transcript ─────────────────────────────────────
console.log("\nA. user's exact transcript, with conversation memory");
_resetMemories();
const convo = convoFor("user-a");

const a1 = await say(convo, "ager sob revert koro ar 0xjnsdjkfbsdj ei address e sob transfer koro");
check("msg1 (revert + malformed 0x) -> revert reply calling out the bad address",
  a1.decision === "clarify" && /not a valid address/i.test(a1.explanation) && /40 hex/i.test(a1.explanation),
  JSON.stringify(a1.explanation).slice(0, 200));
check("msg1 saves pending amount=all token=USDC",
  convo.pending && convo.pending.amount === "all" && convo.pending.token === "USDC",
  JSON.stringify(convo.pending));

const a2 = await say(convo, "usdc ar sob gula");
check("msg2 'usdc ar sob gula' -> asks ONLY for recipient (no token/amount re-ask)",
  a2.decision === "clarify" && /who should receive/i.test(a2.explanation) && !/which token|how much|USDC নাকি/i.test(a2.explanation),
  JSON.stringify(a2.explanation).slice(0, 200));

const a3 = await say(convo, "0xxcvxcvxcvxcvxcv ei address e");
check("msg3 malformed address again -> calls it out, does not loop",
  a3.decision === "clarify" && /0xxcvxcvxcvxcvxcv/i.test(a3.explanation) && /not a valid address/i.test(a3.explanation),
  JSON.stringify(a3.explanation).slice(0, 200));

const a4 = await say(convo, "sob usdc");
check("msg4 'sob usdc' -> still only asks for recipient",
  a4.decision === "clarify" && /who should receive/i.test(a4.explanation) && /all USDC/i.test(a4.explanation),
  JSON.stringify(a4.explanation).slice(0, 200));

const a5 = await say(convo, "savings");
check("msg5 'savings' completes the round -> full-balance transfer resolved and executed through policy",
  ["execute", "queue", "reject"].includes(a5.decision),
  JSON.stringify({ d: a5.decision, e: a5.explanation?.slice(0, 120), r: a5.amountResolved || a5.intent?.amountResolved }));
check("msg5 'all' resolved to the live vault balance",
  JSON.stringify(a5).includes(`"to":${USDC_BAL}`) || a5.intent?.amount === USDC_BAL,
  `expected ${USDC_BAL} in trace`);
check("pending cleared after a non-clarify decision", !convo.pending);

// ── Phase B: LLM sees prior turns ────────────────────────────────────────────
console.log("\nB. LLM history threading (mock OpenAI-compatible server)");
const MOCK_PORT = 8791;
const captured = [];
const mock = (await import("node:http")).createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    captured.push({ url: req.url, body: JSON.parse(body || "{}") });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "mock", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: `{"action":"query","rationale":"ok","confidence":0.9}` }, finish_reason: "stop" }],
    }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

config.llmProviderResolved = "openai";
config.openaiBaseUrl = `http://127.0.0.1:${MOCK_PORT}/v1`;
config.openaiKey = "sk-mock";
_resetMemories();
const convoB = convoFor("user-b");
await say(convoB, "hello there");
await say(convoB, "usdc ar sob gula");
mock.close();

const lastReq = captured[captured.length - 1];
const msgs = lastReq?.body?.messages || [];
check("second request carries the first turn as history",
  msgs.length === 4 && msgs[1].role === "user" && msgs[1].content === "hello there" && msgs[2].role === "assistant",
  JSON.stringify(msgs.map((m) => m.role)));
check("current message is the LAST message, not duplicated",
  msgs[msgs.length - 1].role === "user" && msgs[msgs.length - 1].content === "usdc ar sob gula",
  JSON.stringify(msgs.map((m) => m.content)));
check("system prompt teaches multi-turn + malformed-address + revert + all",
  /MULTI-TURN CHAT/.test(msgs[0].content) && /MALFORMED address/.test(msgs[0].content) &&
  /"revert"/.test(msgs[0].content) && /"all"/.test(msgs[0].content) && /No em-dashes/.test(msgs[0].content));
check("history also recorded in convo turns", convoB.turns.length === 4);
config.llmProviderResolved = "rules";

// ── Phase C: guards ───────────────────────────────────────────────────────────
console.log("\nC. safety guards");
_resetMemories();
const convoC = convoFor("user-c");
const c0 = await say(convoC, "all good thanks");
check("'all good' with no pending is NOT an amount", c0.decision === "clarify" && !/all USDC/i.test(c0.explanation));

_resetMemories();
const convoD = convoFor("user-d");
await say(convoD, "send 50 dollars");                 // asks recipient, pending saved
const c1 = await say(convoD, "that's all");
check("'that's all' mid-round closes the instruction",
  c1.decision === "clarify" && /closed that instruction|nothing was sent/i.test(c1.explanation) && !convoD.pending,
  JSON.stringify(c1.explanation).slice(0, 120));

_resetMemories();
const convoE = convoFor("user-e");
await say(convoE, "send 50 dollars");
const c2 = await say(convoE, "never mind");
check("'never mind' cancels cleanly", /dropped that instruction/i.test(c2.explanation) && !convoE.pending);
const c3 = await say(convoE, "send 50 dollars to mom");
check("fresh command after cancel executes on its own", c3.decision === "execute" || c3.decision === "queue",
  JSON.stringify(c3.decision));

_resetMemories();
const convoF = convoFor("user-f");
const c4 = await say(convoF, "dont move 100 usd to savings");
check("negation guard still refuses (and never becomes pending slots)",
  c4.decision === "clarify" && /did nothing/i.test(c4.explanation) && !convoF.pending);

_resetMemories();
const convoG = convoFor("user-g");
const c5 = await say(convoG, "sob taka 0x9999999999999999999999999999999999999999 address e pathao");
check("'all' to a non-whitelisted valid address still hits the WHITELIST floor",
  c5.decision === "reject" && /whitelist/i.test(c5.explanation),
  JSON.stringify(c5.explanation?.slice(0, 120)));

// unit-level checks
check("extractAmount: 'sob 100 taka' -> number wins", extractAmount("sob 100 taka")?.amount === 100);
check("extractAmount: 'sab paisa' -> all", extractAmount("sab paisa")?.amount === "all");
check("detectInvalidAddress: valid 40-hex is not invalid", detectInvalidAddress("0x1111111111111111111111111111111111111111") === null);
check("isCancelText: 'rehne do' yes / 'thik ache' NO (means okay)",
  isCancelText("rehne do") === true && isCancelText("thik ache") === false);
const m = mergeSlots({ token: null, amount: "all", recipient: null }, { token: "USDC", amount: 100, recipient: { type: "label", value: "Mom" }, at: Date.now() });
check("mergeSlots: fresh 'all' overrides saved 100; saved recipient fills", m.amount === "all" && m.recipient?.value === "Mom" && missingSlots(m).length === 0);

// rules parser: revert action
const r1 = parseIntentRules("ager sob revert koro", WL, { USDC: { available: true } });
check("parser: 'revert koro' -> action revert", r1.action === "revert");
const r2 = parseIntentRules("undo the last payment", WL, { USDC: { available: true } });
check("parser: 'undo the last payment' -> action revert", r2.action === "revert");
const r3 = parseIntentRules("what did you revert?", WL, { USDC: { available: true } });
check("parser: 'what did you revert?' stays a query", r3.action === "query");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
