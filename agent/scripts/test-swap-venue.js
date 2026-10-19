// Swap-venue regression tests (v3.9.4 feature set).
//
// The bug this suite pins down: "Swap 50 dollars to ETH" was REJECTED with an
// opaque "unknown custom error". The pre-flight guardrail behaved correctly
// (it refused to broadcast a swap that would revert on-chain), but:
//   * the venue's ETH inventory had run dry (MockSwap pays buy-side payouts
//     from its own balance and nobody refilled it), and
//   * the revert could not be named because the agent only knew the vault's
//     custom errors — MockSwap's errors decoded to nothing.
//
// Phase A: explainRevert names vault, venue and ERC-20 custom errors, and
//          keeps the selector visible for truly unknown ones
// Phase B: venueTopUpPlan decides the capped ETH top-up correctly
// Phase C: the executor swap branch — venue liquidity is ensured BEFORE the
//          pre-flight simulation, quote failures become clean REJECTs, and
//          rejections name the real cause with an actionable hint
// Usage: npm run test:venue   (from agent/, no chain and no LLM key needed)
process.env.LLM_PROVIDER = "rules";
process.env.RPC_URL = "http://127.0.0.1:8545";

// Importing the executor pulls in the live chain module; ethers probes the
// RPC in the background even though this suite only ever uses stubs. Swallow
// exactly that noise source so real failures still fail the test loudly.
process.on("unhandledRejection", (err) => {
  if (String(err?.message || err).includes("ECONNREFUSED")) return;
  console.error("unhandled rejection:", err);
  process.exit(1);
});

const { readFileSync } = await import("node:fs");
const { resolve } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { ethers } = await import("ethers");

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const { config, AGENT_VERSION } = await import(`${ROOT}/src/config.js`);
config.dryRun = false; // the swap branch must run simulate + the liquidity hook

const { processCommand } = await import(`${ROOT}/src/executor.js`);
const { explainRevert, venueTopUpPlan } = await import(`${ROOT}/src/chain.js`);
const { VAULT_ABI, VENUE_ABI, ERC20_ABI } = await import(`${ROOT}/src/abi.js`);

const fixture = JSON.parse(readFileSync(resolve(ROOT, "eval/fixture-state.json"), "utf8"));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

/** Build revert data exactly as the chain would: selector + abi-encoded args. */
const vaultIface = new ethers.Interface(VAULT_ABI);
const venueIface = new ethers.Interface(VENUE_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const errOf = (data) => ({ info: { error: { data } } });
const encErr = (iface, name, types = null, values = []) =>
  iface.getError(name).selector + (types ? ethers.AbiCoder.defaultAbiCoder().encode(types, values).slice(2) : "");

// ── Phase A: error decoding ───────────────────────────────────────────────────
console.log("\nA. explainRevert names the real revert instead of \"unknown custom error\"");

check("vault custom error still decodes",
  explainRevert(errOf(encErr(vaultIface, "Aegis__InvalidAmount"))) === "Aegis__InvalidAmount()",
  explainRevert(errOf(encErr(vaultIface, "Aegis__InvalidAmount"))));

check("venue zero-arg error decodes (the screenshot bug: MockSwap__EthPayoutFailed)",
  explainRevert(errOf(encErr(venueIface, "MockSwap__EthPayoutFailed"))) === "MockSwap__EthPayoutFailed()",
  explainRevert(errOf(encErr(venueIface, "MockSwap__EthPayoutFailed"))));

const usdcAddr = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const zeroAddr = "0x0000000000000000000000000000000000000000";
const rateNotSet = explainRevert(errOf(encErr(venueIface, "MockSwap__RateNotSet", ["address", "address"], [usdcAddr, zeroAddr])));
check("venue error with args decodes with its arguments",
  rateNotSet.toLowerCase().startsWith("mockswap__ratenotset(0x") &&
  rateNotSet.toLowerCase().includes(usdcAddr) && rateNotSet.toLowerCase().includes(zeroAddr),
  rateNotSet);

const erc20Short = explainRevert(errOf(encErr(erc20Iface, "ERC20InsufficientBalance", ["address", "uint256", "uint256"], [usdcAddr, 100n, 200n])));
check("ERC-20 (OpenZeppelin v5) error decodes with its arguments",
  erc20Short.startsWith("ERC20InsufficientBalance(0x") && erc20Short.includes("100") && erc20Short.includes("200"),
  erc20Short);

const unknown = explainRevert(errOf("0xdeadbeef" + "00".repeat(28)));
check("truly unknown revert keeps its 4-byte selector visible",
  unknown.startsWith("unknown custom error 0xdeadbeef") && unknown.includes("data 0x"),
  unknown);

check("errors without revert data fall back to the short message",
  explainRevert({ shortMessage: "user rejected" }) === "user rejected");

// ── Phase B: the venue ETH top-up decision ────────────────────────────────────
console.log("\nB. venueTopUpPlan (defaults: min 0.02, target 0.1, gas reserve 0.01)");
Object.assign(config, { venueEthMin: 0.02, venueEthTarget: 0.1, venueGasReserveEth: 0.01 });
const near = (a, b) => Math.abs(a - b) < 1e-9;

check("healthy venue + small payout -> no top-up",
  venueTopUpPlan(0.1, 0.3, 0.0125).action === "none");

check("boot check: venue above the minimum -> no top-up",
  venueTopUpPlan(0.03, 0.3, 0).action === "none");

check("dry venue (no payout) -> refill to the target",
  venueTopUpPlan(0.005, 0.3, 0).action === "send" && near(venueTopUpPlan(0.005, 0.3, 0).amountEth, 0.095));

check("dry venue + payout -> refill to the target (covers the payout)",
  venueTopUpPlan(0.005, 0.3, 0.05).action === "send" && near(venueTopUpPlan(0.005, 0.3, 0.05).amountEth, 0.095));

check("large payout -> top up at least the shortfall even past the target",
  venueTopUpPlan(0.05, 0.3, 0.25).action === "send" && near(venueTopUpPlan(0.05, 0.3, 0.25).amountEth, 0.22));

check("top-up is capped by what the agent key can spare",
  venueTopUpPlan(0.005, 0.012, 0).action === "send" && near(venueTopUpPlan(0.005, 0.012, 0).amountEth, 0.002));

const cant = venueTopUpPlan(0.005, 0.008, 0);
check("broke agent key -> refuse with a reason, never spend the gas reserve",
  cant.action === "cant" && /gas reserve/.test(cant.reason), JSON.stringify(cant));

// ── Phase C: the executor swap branch ─────────────────────────────────────────
console.log("\nC. executor swap branch (stubbed chain, live decision matrix)");

const mkStub = (over = {}) => ({
  snapshot: async () => fixture,
  pendingQueue: async () => [],
  codesizeMap: async () => ({}),
  send: async () => ({ hash: "dry-run", ok: true, receipt: null }),
  simulate: async () => ({ ok: true }),
  quoteSwap: async () => ({ sellSymbol: "USDC", buySymbol: "ETH", expectedOutHuman: 0.0125, minOutHuman: 0.0123, minOutBase: "12340000000000000" }),
  ensureVenueLiquidity: async () => ({ ok: true }),
  ...over,
});
const fakeJournal = { append() {}, decisions() { return []; } };

const runSwap = async (stub) =>
  processCommand("convert 50 dollars to eth", { state: fixture, codesizeMap: {}, chain: stub, journal: fakeJournal });

// C1: the exact screenshot scenario, now with the venue error NAMED
{
  const order = [];
  const stub = mkStub({
    quoteSwap: async () => { order.push("quote"); return { sellSymbol: "USDC", buySymbol: "ETH", expectedOutHuman: 0.0125, minOutHuman: 0.0123, minOutBase: "12340000000000000" }; },
    ensureVenueLiquidity: async () => { order.push("ensure"); return { ok: true }; },
    simulate: async () => { order.push("simulate"); return { ok: false, revert: "MockSwap__EthPayoutFailed()" }; },
    send: async () => { order.push("send"); return { hash: "dry-run", ok: true }; },
  });
  const d = await runSwap(stub);
  check("dry venue -> REJECT that names MockSwap__EthPayoutFailed",
    d.decision === "reject" && d.explanation.includes("MockSwap__EthPayoutFailed()"),
    JSON.stringify(d.explanation));
  check("the reject tells the user what to do (fund the venue / agent key)",
    /no ETH left to pay out/.test(d.explanation) && /top-up did not complete/.test(d.explanation),
    JSON.stringify(d.explanation));
  check("categorized as a Balance problem, not a generic RiskEngine reject",
    d.rejectionCategory === "Balance", String(d.rejectionCategory));
  check("venue liquidity is ensured BEFORE the pre-flight simulation",
    order.indexOf("quote") > -1 && order.indexOf("quote") < order.indexOf("ensure") && order.indexOf("ensure") < order.indexOf("simulate"),
    order.join(","));
}

// C2: ensure itself fails (broke agent key) -> the swap still gets a named reject
{
  const stub = mkStub({
    ensureVenueLiquidity: async () => ({ ok: false, reason: "the agent key can spare 0.0000 ETH" }),
    simulate: async () => ({ ok: false, revert: "MockSwap__EthPayoutFailed()" }),
  });
  const d = await runSwap(stub);
  check("failed top-up -> still a clean named REJECT, reason kept in the trace",
    d.decision === "reject" && d.venueLiquidity && d.venueLiquidity.reason.includes("0.0000 ETH"),
    JSON.stringify({ e: d.explanation, v: d.venueLiquidity }));
}

// C3: healthy path -> swap executes, liquidity check recorded
{
  const stub = mkStub({
    ensureVenueLiquidity: async () => ({ ok: true, toppedUpEth: 0.095, tx: "0xabc" }),
  });
  const d = await runSwap(stub);
  check("refilled venue -> swap executes",
    d.decision === "swap" && /Quoted 0\.0125 ETH/.test(d.explanation),
    JSON.stringify({ d: d.decision, e: d.explanation }));
  check("the top-up lands in the decision trace",
    d.venueLiquidity && d.venueLiquidity.toppedUpEth === 0.095,
    JSON.stringify(d.venueLiquidity));
}

// C4: the quote itself refuses (unpriced pair) -> clean REJECT, not a 500
{
  const stub = mkStub({
    quoteSwap: async () => { throw new Error("the venue refused to quote this pair: MockSwap__RateNotSet(0xabc, 0x0000000000000000000000000000000000000000)"); },
  });
  const d = await runSwap(stub);
  check("unpriced pair -> REJECT names RateNotSet and says who must act",
    d.decision === "reject" && /Could not quote this swap/.test(d.explanation) &&
    /MockSwap__RateNotSet/.test(d.explanation) && /setRate/.test(d.explanation),
    JSON.stringify(d.explanation));
}

// C5: legacy context without ensureVenueLiquidity (judge mode pre-v3.9.4) keeps working
{
  const stub = mkStub();
  delete stub.ensureVenueLiquidity;
  stub.simulate = async () => ({ ok: false, revert: "MockSwap__BelowMinOut(1, 2)" });
  const d = await runSwap(stub);
  check("legacy chain context (no ensure hook) -> no crash, slippage still categorized",
    d.decision === "reject" && d.rejectionCategory === "Slippage" && /BelowMinOut/.test(d.explanation),
    JSON.stringify({ d: d.decision, e: d.explanation, c: d.rejectionCategory }));
}

// ── Phase D: build identity ───────────────────────────────────────────────────
console.log("\nD. build identity");
check("AGENT_VERSION is v3.9.4", AGENT_VERSION === "v3.9.4", AGENT_VERSION);

console.log(`\n${pass} passed, ${fail} failed ${fail ? "\nTEST SUITE FAILED" : "(swap-venue regression suite)"}`);
process.exit(fail ? 1 : 0);
