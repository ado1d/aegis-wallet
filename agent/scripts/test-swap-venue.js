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

check("payout no affordable refill can cover -> named too-large (not a partial send)",
  venueTopUpPlan(0.005, 0.012, 0.05).action === "too-large" &&
  /pays out 0\.0500 ETH/.test(venueTopUpPlan(0.005, 0.012, 0.05).reason),
  JSON.stringify(venueTopUpPlan(0.005, 0.012, 0.05)));

check("huge payout vs a healthy key -> still too-large, numbers honest",
  venueTopUpPlan(0.04, 0.3, 1.25).action === "too-large" &&
  /at most 0\.3300 ETH/.test(venueTopUpPlan(0.04, 0.3, 1.25).reason),
  JSON.stringify(venueTopUpPlan(0.04, 0.3, 1.25)));

check("payout the agent CAN cover -> still a normal send, not too-large",
  venueTopUpPlan(0.005, 0.3, 0.05).action === "send" &&
  near(venueTopUpPlan(0.005, 0.3, 0.05).amountEth, 0.095));

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

// C6: review-band swap (the v3.9.4 crash). Risk score 30-59 on a swap used to
// fall into the transfer-queue path, which read intent.recipient.address
// (undefined on swaps) and 500'd the command route. It must now refuse cleanly.
{
  // deterministic review band: 950 USDC = 95% of the per-tx cap (+10 anomaly),
  // >3x the 1 USDC median history spend (+20 anomaly), 6 live window entries
  // (+15 velocity) -> score 45 = "review" (thresholds 30/60, no HF token)
  const rs = JSON.parse(JSON.stringify(fixture));
  rs.tokens.USDC = {
    ...rs.tokens.USDC,
    vaultBalance: "5000000000", maxPerTx: "1000000000",
    dailyLimit: "2500000000", spentInWindow: "0", liveEntries: 6,
  };
  rs.history = [{ token: "USDC", amount: "1000000" }];
  const d = await processCommand("convert 950 dollars to eth", {
    state: rs, codesizeMap: {}, chain: mkStub(), journal: fakeJournal,
  });
  check("review-band swap -> clean REJECT (old code crashed with a 500)",
    d.decision === "reject" && d.rejectionCategory === "RiskEngine",
    JSON.stringify({ d: d.decision, c: d.rejectionCategory }));
  check("the refusal explains WHY swaps cannot queue and what to do",
    /no human-approval queue/.test(d.explanation) && /Nothing was swapped/.test(d.explanation) &&
    /smaller amount/.test(d.explanation),
    JSON.stringify(d.explanation));
  check("the risk signals and score are visible in the refusal",
    new RegExp(`score ${d.risk?.score}/100`).test(d.explanation) && d.risk?.score >= 30 && d.risk?.score < 60,
    JSON.stringify({ score: d.risk?.score, band: d.risk?.band }));
}

// C7: oracle off-market quote -> refused BEFORE the venue top-up or simulation
{
  const order = [];
  const stub = mkStub({
    quoteSwap: async () => { order.push("quote"); return { sellSymbol: "USDC", buySymbol: "ETH", expectedOutHuman: 0.004, minOutHuman: 0.0039, minOutBase: "3940000000000000" }; },
    oracleCheck: async () => { order.push("oracle"); return { ok: false, verdict: "off-market", impliedUsdPerEth: 12500, oracleUsdPerEth: 2423.48, driftPct: 415.8, maxDriftPct: 90 }; },
    ensureVenueLiquidity: async () => { order.push("ensure"); return { ok: true }; },
    simulate: async () => { order.push("simulate"); return { ok: true }; },
  });
  const d = await runSwap(stub);
  check("off-market venue rate -> REJECT naming both prices and the limit",
    d.decision === "reject" && d.rejectionCategory === "Slippage" &&
    /\$12500\.00 per ETH/.test(d.explanation) && /\$2423\.48/.test(d.explanation) &&
    /415\.8% apart, limit 90%/.test(d.explanation),
    JSON.stringify(d.explanation));
  check("nothing moves after an off-market quote: no top-up, no simulation",
    order.join(",") === "quote,oracle",
    order.join(","));
}

// C8: within-band drift -> swap executes AND discloses the venue-vs-market gap
{
  const stub = mkStub({
    oracleCheck: async () => ({ ok: true, verdict: "within", impliedUsdPerEth: 4000, oracleUsdPerEth: 2423.48, driftPct: 65.1, maxDriftPct: 90, feed: "0x694AA1769357215DE4FAC081bf1f309aDC325306" }),
    ensureVenueLiquidity: async () => ({ ok: true }),
  });
  const d = await runSwap(stub);
  check("65% drift inside the 90% band still swaps (fixed-rate demo venue)",
    d.decision === "swap" && /Quoted 0\.0125 ETH/.test(d.explanation),
    JSON.stringify({ d: d.decision, e: d.explanation }));
  check("the reply DISCLOSES the market reference price and the gap",
    /Reference price: Chainlink ETH\/USD \$2423\.48/.test(d.explanation) &&
    /implies \$4000\.00 per ETH/.test(d.explanation) && /65\.1% above market/.test(d.explanation),
    JSON.stringify(d.explanation));
  check("the oracle verdict lands in the decision trace",
    d.oracle && d.oracle.verdict === "within" && d.oracle.driftPct === 65.1,
    JSON.stringify(d.oracle));
}

// C9: swap too large for venue liquidity -> refused before simulate with the
// real numbers (a 1.25 ETH payout vs a venue that can never hold it)
{
  const order = [];
  const stub = mkStub({
    oracleCheck: async () => ({ ok: true, verdict: "within", impliedUsdPerEth: 4000, oracleUsdPerEth: 2423.48, driftPct: 65.1, maxDriftPct: 90 }),
    ensureVenueLiquidity: async () => {
      order.push("ensure");
      return { ok: false, tooLarge: true, reason: "this swap pays out 1.2500 ETH (plus the 0.0200 ETH venue buffer), but the venue can hold at most 0.3300 ETH (0.0400 ETH held + what the agent key can spare)" };
    },
    simulate: async () => { order.push("simulate"); return { ok: true }; },
    send: async () => { order.push("send"); return { hash: "dry-run", ok: true }; },
  });
  const d = await processCommand("convert 5000 dollars to eth", {
    state: { ...fixture, tokens: { ...fixture.tokens, USDC: { ...fixture.tokens.USDC, vaultBalance: "5000000000", maxPerTx: "10000000000", dailyLimit: "10000000000", spentInWindow: "0", liveEntries: 1 } }, history: [] },
    codesizeMap: {}, chain: stub, journal: fakeJournal,
  });
  check("too-large swap -> REJECT with the payout and the reachable cap",
    d.decision === "reject" && d.rejectionCategory === "Balance" &&
    /pays out 1\.2500 ETH/.test(d.explanation) && /at most 0\.3300 ETH/.test(d.explanation),
    JSON.stringify(d.explanation));
  check("the refusal tells the user what actually helps (smaller swaps), and never simulates",
    /Split it into smaller swaps/.test(d.explanation) && order.join(",") === "ensure",
    JSON.stringify({ order: order.join(","), e: d.explanation }));
}

// C10: the live 2026-10-19 scenario — "0.04 eth to usd" where the venue only
// prices the reverse pair. The refusal must (a) parse the direction correctly
// even under the rules fallback ("usd" = USDC sell target), and (b) tell the
// user the opposite direction still works instead of a dead end.
{
  const calls = [];
  const stub = mkStub({
    quoteSwap: async (sell, buy, amount) => {
      calls.push(`${sell}->${buy}:${amount}`);
      if (sell === "ETH") {
        throw new Error("the venue refused to quote this pair: MockSwap__RateNotSet(0x0000000000000000000000000000000000000000, 0x5fbdb2315678afecb367f032d93f642f64180aa3)");
      }
      return { sellSymbol: sell, buySymbol: buy, expectedOutHuman: 0.0125, minOutHuman: 0.0123, minOutBase: "12340000000000000" };
    },
  });
  const d = await processCommand("convert 0.04 eth to usd", {
    state: fixture, codesizeMap: {}, chain: stub, journal: fakeJournal,
  });
  check("rules fallback parses 'eth to usd' as sell-ETH (the alias fix)",
    d.intent?.action === "swap" && d.intent?.token === "ETH" && d.intent?.buyToken === "USDC",
    JSON.stringify({ token: d.intent?.token, buy: d.intent?.buyToken }));
  check("unpriced ETH->USDC -> REJECT names RateNotSet AND the working direction",
    d.decision === "reject" && /Could not quote this swap/.test(d.explanation) &&
    /MockSwap__RateNotSet/.test(d.explanation) && /setRate/.test(d.explanation) &&
    /The opposite direction \(USDC \u2192 ETH\) is currently available/.test(d.explanation),
    JSON.stringify(d.explanation));
  check("the reverse probe was a single read-only quote, nothing else moved",
    calls.length === 2 && calls[0] === "ETH->USDC:0.04" && calls[1] === "USDC->ETH:1",
    calls.join(","));
}

// C11: BOTH directions unpriced -> the refusal stays honest, no phantom hint,
// and the probe's own failure never crashes the reject path
{
  const stub = mkStub({
    quoteSwap: async () => { throw new Error("the venue refused to quote this pair: MockSwap__RateNotSet(0x0000000000000000000000000000000000000000, 0x5fbdb2315678afecb367f032d93f642f64180aa3)"); },
  });
  const d = await processCommand("convert 0.04 eth to usdc", {
    state: fixture, codesizeMap: {}, chain: stub, journal: fakeJournal,
  });
  check("both directions unpriced -> clean REJECT, no opposite-direction hint",
    d.decision === "reject" && /Could not quote this swap/.test(d.explanation) &&
    !/opposite direction/i.test(d.explanation),
    JSON.stringify(d.explanation));
}

// ── Phase D: build identity ───────────────────────────────────────────────────
console.log("\nD. build identity");
check("AGENT_VERSION is v3.9.5", AGENT_VERSION === "v3.9.5", AGENT_VERSION);

// ── Phase E: oracle price sanity (pure math, no chain) ────────────────────────
console.log("\nE. venueRateSanity (oracle cross-check, band 90%)");
const { venueRateSanity, oracleDisclosure } = await import(`${ROOT}/src/oracle.js`);

{
  const s = venueRateSanity({ sellSymbol: "USDC", buySymbol: "ETH", sellAmountHuman: 50, expectedOutHuman: 0.0125 }, 2423.48, 90);
  check("USDC->ETH at the live venue rate ($4,000 implied) is within the 90% band",
    s.ok && s.verdict === "within" && s.impliedUsdPerEth === 4000 && s.driftPct === 65.1,
    JSON.stringify(s));
}
{
  const s = venueRateSanity({ sellSymbol: "USDC", buySymbol: "ETH", sellAmountHuman: 50, expectedOutHuman: 0.002 }, 2423.48, 90);
  check("a 10x fat-fingered rate ($25,000 implied) is off-market",
    !s.ok && s.verdict === "off-market" && Math.abs(s.driftPct) > 900,
    JSON.stringify(s));
}
{
  const s = venueRateSanity({ sellSymbol: "ETH", buySymbol: "USDC", sellAmountHuman: 0.05, expectedOutHuman: 121.17 }, 2423.48, 90);
  check("ETH->USDC implied price = out/sell, market-anchored rate is within",
    s.ok && s.verdict === "within" && s.impliedUsdPerEth === 2423.4,
    JSON.stringify(s));
}
{
  const s = venueRateSanity({ sellSymbol: "USDC", buySymbol: "ETH", sellAmountHuman: 50, expectedOutHuman: 0.25 }, 2423.48, 90);
  check("a venue paying 10x TOO MUCH (negative drift) is also flagged broken",
    !s.ok && s.verdict === "off-market" && s.driftPct < -90,
    JSON.stringify(s));
}
{
  const s = venueRateSanity({ sellSymbol: "USDC", buySymbol: "ETH", sellAmountHuman: 50, expectedOutHuman: 0 }, 2423.48, 90);
  check("a zero-output quote is refused, never treated as a free price",
    !s.ok && s.verdict === "off-market",
    JSON.stringify(s));
}
{
  const s = venueRateSanity({ sellSymbol: "USDC", buySymbol: "ETH", sellAmountHuman: 50, expectedOutHuman: 0.0125 }, 0, 90);
  check("no oracle price -> the check reports itself skipped (anvil, no feed)",
    s.ok && s.verdict === "skipped",
    JSON.stringify(s));
}
{
  const d = oracleDisclosure({ verdict: "within", impliedUsdPerEth: 4000, oracleUsdPerEth: 2423.48, driftPct: 65.1 });
  check("disclosure line names both prices and the direction",
    /Chainlink ETH\/USD \$2423\.48/.test(d) && /65\.1% above market/.test(d),
    d);
  check("small drift (<1%) stays silent, warn-only states stay silent",
    oracleDisclosure({ verdict: "within", impliedUsdPerEth: 2425, oracleUsdPerEth: 2423.48, driftPct: 0.06 }) === "" &&
    oracleDisclosure(null) === "" && oracleDisclosure({ warn: "oracle stale" }) === "",
    "unexpected disclosure for quiet cases");
}

console.log(`\n${pass} passed, ${fail} failed ${fail ? "\nTEST SUITE FAILED" : "(swap-venue regression suite)"}`);
process.exit(fail ? 1 : 0);
