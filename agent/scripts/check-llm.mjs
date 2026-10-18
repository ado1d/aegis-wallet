// One-command pre-flight: proves your LLM key works BEFORE you open the app.
//
//   cd agent
//   npm run check:llm                       # uses agent/.env as-is
//   LLM_PROVIDER=openai OPENAI_API_KEY=sk-... npm run check:llm   # no .env edit needed
//
// Sends ONE tiny chat request through the exact same code path the app uses
// (src/llm.js parseIntent), so if this prints OK the Console will parse with
// your model too. Cost: a fraction of a cent on gpt-4o-mini.
import { parseIntent } from "../src/llm.js";
import { config } from "../src/config.js";

const WHITELIST = [{ label: "Savings", address: "0x0000000000000000000000000000000000000001" }];
const TOKENS = ["USDC", "ETH"];
const CMD = "could you move fifty bucks into my savings wallet please";

console.log(`Aegis LLM pre-flight`);
console.log(`  provider : ${config.llmProvider === config.llmProviderResolved ? config.llmProvider : `${config.llmProvider} → ${config.llmProviderResolved} (auto-detected)`}`);
console.log(`  model    : ${config.llmModelSet ? config.llmModel : "(provider default: gpt-4o-mini / Llama-3.1-8B)"}`);
if (config.llmProviderResolved === "openai") {
  console.log(`  endpoint : ${config.openaiBaseUrl}`);
  console.log(`  key      : ${config.openaiKey ? `${config.openaiKey.slice(0, 6)}…${config.openaiKey.slice(-4)} loaded` : "OPENAI_API_KEY NOT SET"}`);
}
if (config.llmProviderResolved === "huggingface" || config.llmProviderResolved === "hf") {
  console.log(`  endpoint : ${config.hfBaseUrl}`);
  console.log(`  key      : ${config.hfToken ? `${config.hfToken.slice(0, 5)}… loaded` : "HF_TOKEN NOT SET"}`);
}

if (config.llmProviderResolved === "rules") {
  console.log(`\nNo usable LLM key resolved${config.llmProvider === "auto" ? " (LLM_PROVIDER=auto found no OPENAI_API_KEY / HF_TOKEN)" : " (provider is 'rules')"}.`);
  console.log(`To parse with your OpenAI key, put this in agent/.env and re-run:`);
  console.log(`  OPENAI_API_KEY=sk-...        # LLM_PROVIDER=auto picks it up automatically`);
  process.exit(0);
}

const needed =
  config.llmProviderResolved === "openai" ? config.openaiKey :
  (config.llmProviderResolved === "huggingface" || config.llmProviderResolved === "hf") ? config.hfToken : true;
if (!needed) {
  console.log(`\n✗ ${config.llmProviderResolved === "openai" ? "OPENAI_API_KEY" : "HF_TOKEN"} is not set — nothing to test.`);
  console.log(`  (The app still works: every command falls back to the deterministic rules parser.)`);
  process.exit(1);
}

console.log(`\nSending one test command: "${CMD}"`);
const t0 = Date.now();
const { intent, meta } = await parseIntent(CMD, WHITELIST, TOKENS);
const ms = Date.now() - t0;

if (meta.llmUsed) {
  console.log(`\n✓ OK — your ${config.llmProviderResolved} key works (${ms} ms)`);
  console.log(`  parsed  : ${JSON.stringify({ action: intent.action, token: intent.token, recipient: intent.recipient?.value ?? intent.recipient, amount: intent.amount })}`);
  console.log(`  parser  : ${intent.parser} via provider '${meta.provider}'`);
  console.log(`\nThe app is armed. Start the agent (node src/server.js) and try the same`);
  console.log(`sentence in the Console tab — its decision trace will show your model.`);
} else {
  console.log(`\n✗ The call FAILED and the parser fell back to rules. Reason:`);
  console.log(`  ${meta.fallback || "schema validation rejected the model output"}`);
  console.log(`\nCommon fixes:`);
  console.log(`  400 temperature         → gpt-5*/o-series model on an agent older than v3.1 — update the zip, or empty LLM_MODEL`);
  console.log(`  401 incorrect key        → copy it again from platform.openai.com (sk-…, no spaces/quotes)`);
  console.log(`  429 insufficient_quota   → no credit left on the account / billing not set up`);
  console.log(`  404 model not found      → your account can't call LLM_MODEL; empty the line for the default`);
  console.log(`  timeout                  → raise LLM_TIMEOUT_MS (default 15000)`);
  console.log(`\nThe app still works meanwhile — every command just uses the rules parser.`);
  process.exit(1);
}
