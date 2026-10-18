// Circuit-breaker half-open cycle test (v3.6 feature set).
// Tiny cooldown -> after it expires, next call retries the LLM once (fails),
// re-opens the breaker, following calls instant again.
// Usage: npm run test:breaker   (from agent/, no chain and no real key needed)
process.env.LLM_TIMEOUT_MS = "1500";
process.env.LLM_COOLDOWN_MS = "800";
process.env.LLM_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "sk-test";
process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
process.env.RPC_URL = "http://127.0.0.1:8545";

const HERE = new URL("../", import.meta.url).href;
const { parseIntent, llmStatus } = await import(`${HERE}src/llm.js`);
const WL = [{ label: "Savings", address: "0x1111111111111111111111111111111111111111" }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1st + 2nd failures (breaker closed -> opens)
await parseIntent("send 10 to savings", WL, ["USDC", "ETH"]);
await parseIntent("send 10 to savings", WL, ["USDC", "ETH"]);
let st = llmStatus();
console.log("after 2 fails  :", st.breaker, "| fails:", st.consecutiveFailures);
if (!/open/.test(st.breaker)) { console.log("FAIL: breaker should be open"); process.exit(1); }

// open -> instant
let t0 = Date.now();
await parseIntent("send 10 to savings", WL, ["USDC", "ETH"]);
console.log("cooldown call  :", `${Date.now() - t0}ms (expect <50ms)`);
if (Date.now() - t0 > 400) { console.log("FAIL: cooldown call too slow"); process.exit(1); }

// wait out cooldown -> half-open: one real retry, fails, re-opens
await sleep(900);
t0 = Date.now();
const r = await parseIntent("send 10 to savings", WL, ["USDC", "ETH"]);
const ms = Date.now() - t0;
st = llmStatus();
console.log("half-open retry:", `${ms}ms provider=${r.meta.provider}`);
console.log("state after    :", st.breaker, "| fails:", st.consecutiveFailures);
if (r.meta.provider !== "rules(fallback)") { console.log("FAIL: half-open should have retried LLM"); process.exit(1); }
if (!/open/.test(st.breaker)) { console.log("FAIL: breaker should re-open after failed retry"); process.exit(1); }

// and instantly cool again
t0 = Date.now();
await parseIntent("send 10 to savings", WL, ["USDC", "ETH"]);
console.log("post-reopen    :", `${Date.now() - t0}ms (expect <50ms)`);
console.log("\nALL HALF-OPEN CYCLE CHECKS PASSED");
