import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(HERE, "..");

/** Minimal .env parser (KEY=VALUE lines, # comments — also inline after values — zero dependencies). */
function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      // strip inline comments:  KEY=value   # explanation
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadEnvFile(resolve(AGENT_ROOT, ".env")), ...process.env };

// Build identity — printed in the startup banner and served by /health so a
// console screenshot instantly answers "which build is this?". Bump on every
// repackaged zip (v3.9 = hosted deployment: serverless surface (Vercel),
// Postgres-backed conversation memory, operator fuel gauge in /health).
export const AGENT_VERSION = "v3.9.7"; // v3.9.7 = help assistant: POST /me/help guidance route, live-facts LLM persona + deterministic FAQ fallback; v3.9.6 = refusal UX: honest over-cap advice, audit-entry note, working-direction hint; v3.9.5 = swap guardrails: Chainlink price verification, too-large refusal, review-band swap fix

// Values that fail to parse fall back to their default WITH a loud warning
// instead of poisoning the pipeline as NaN. (CP2 shipped a parser that did
// not strip inline comments: `AMOUNT_ANOMALY_X=3  # note` parsed as NaN and
// `BigInt(NaN)` later crashed every risk-scored command with
// "The number NaN cannot be converted to a BigInt…". Never again.)
export const configWarnings = [];

const num = (k, d) => {
  if (env[k] === undefined || env[k] === "") return d;
  const v = Number(env[k]);
  if (!Number.isFinite(v)) {
    configWarnings.push(`${k}=${JSON.stringify(env[k])} is not a number — using default ${d}`);
    return d;
  }
  return v;
};

const bool = (k, d) => {
  if (env[k] === undefined || env[k] === "") return d;
  const v = String(env[k]).toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  configWarnings.push(`${k}=${JSON.stringify(env[k])} is not a boolean (true/false) — using default ${d}`);
  return d;
};

export const config = {
  agentRoot: AGENT_ROOT,

  rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
  vault: env.VAULT_ADDRESS || "",
  venue: env.VENUE_ADDRESS || "",
  usdc: env.USDC_ADDRESS || "",

  // Block explorer for tx/address links in agent replies. Empty = derive from
  // the chain id (sepolia/mainnet/amoy are known; see chain.js chainInfo).
  // Set it explicitly for any other chain, e.g. EXPLORER_URL=https://base-sepolia.basescan.org
  explorerUrl: env.EXPLORER_URL || "",
  // Bound for the request-path self-heal wait (and a guide for provisioning on
  // slow chains). 0 = auto: 30s on anvil (instant blocks), 180s on live chains
  // where a full re-provision is 6+ transactions at ~12s each.
  provisionTimeoutMs: num("PROVISION_TIMEOUT_MS", 0),

  ownerKey: env.OWNER_KEY || "",
  agentKey: env.AGENT_KEY || "",

  // intent extraction. Default "auto" = use the LLM whenever a key is
  // present (OPENAI_API_KEY first, then HF_TOKEN), rules only when no key
  // exists — "a key in .env means the LLM parses your commands" with zero
  // configuration. Explicit rules|openai|huggingface|zai|all still wins.
  llmProvider: (env.LLM_PROVIDER || "auto").toLowerCase(), // auto | rules | openai | huggingface | zai | all
  llmProviderAuto: !(env.LLM_PROVIDER || "").trim() || (env.LLM_PROVIDER || "auto").toLowerCase() === "auto",
  llmProviderResolved: ( // what actually parses intents after auto-detect
    (env.LLM_PROVIDER || "auto").toLowerCase() === "auto"
      ? env.OPENAI_API_KEY ? "openai" : env.HF_TOKEN ? "huggingface" : "rules"
      : (env.LLM_PROVIDER || "rules").toLowerCase()
  ),
  llmModel: env.LLM_MODEL || "gpt-4o-mini",
  llmModelSet: Boolean(env.LLM_MODEL), // distinguishes "unset" (provider default) from an explicit choice
  openaiKey: env.OPENAI_API_KEY || "",
  openaiBaseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  llmTimeoutMs: num("LLM_TIMEOUT_MS", 15000),
  // Circuit breaker: after 2 consecutive LLM failures the breaker OPENS and
  // intents parse instantly via the rules engine (no timeout tax per message)
  // until this cooldown elapses; the next message then retries the LLM.
  llmCooldownMs: num("LLM_COOLDOWN_MS", 60000),
  // Optional HTTP(S) proxy for LLM calls. Node's built-in fetch IGNORES
  // HTTP_PROXY/HTTPS_PROXY env vars, so WSL/VPN setups that only reach the
  // internet through a Windows-side proxy die with "fetch failed". Setting
  // HTTPS_PROXY here routes LLM traffic through it (needs `npm i undici`).
  httpsProxy: env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || "",

  // optional HF advisory signals (FinBERT/MiniLM) AND the `huggingface` LLM
  // intent provider — one token powers both (router.huggingface.co/v1).
  hfToken: env.HF_TOKEN || "",
  hfBaseUrl: (env.HF_BASE_URL || "https://router.huggingface.co/v1").replace(/\/$/, ""),

  // risk / decision tuning
  autoRiskThreshold: num("AUTO_RISK_THRESHOLD", 30),
  rejectRiskThreshold: num("REJECT_RISK_THRESHOLD", 60),
  velocityWindowEntries: num("VELOCITY_WINDOW_ENTRIES", 6),
  amountAnomalyX: num("AMOUNT_ANOMALY_X", 3),
  slippageBps: num("SLIPPAGE_BPS", 150),

  // swap-venue inventory self-heal (chain.ensureVenueLiquidity). The shared
  // MockSwap counterparty pays buy-side payouts from its OWN balance: every
  // USDC->ETH swap drains its ETH. When the venue drops below VENUE_ETH_MIN
  // the agent key tops it back up to VENUE_ETH_TARGET, never spending its
  // last VENUE_GAS_RESERVE_ETH of gas money. The venue's USDC inventory
  // (ETH->USDC swaps) refills the same way from the open testnet mint.
  venueEthMin: num("VENUE_ETH_MIN", 0.02),
  venueEthTarget: num("VENUE_ETH_TARGET", 0.1),
  venueGasReserveEth: num("VENUE_GAS_RESERVE_ETH", 0.01),
  venueUsdcMin: num("VENUE_USDC_MIN", 1000),
  venueUsdcTarget: num("VENUE_USDC_TARGET", 5000),

  // independent swap-price verification (oracle.js, v3.9.5). The venue's
  // rate is owner-set; every quote is checked against the Chainlink ETH/USD
  // feed before money moves. Outside ORACLE_MAX_DRIFT_PCT the swap is
  // refused; inside the band the reply still discloses the venue-vs-market
  // gap. Default band is loose (90%) because the Sepolia demo venue carries
  // a FIXED $4,000/ETH rate set at deployment: use 2-5 for a production or
  // market-tracking venue. ORACLE_FEED empty = auto (Sepolia feed on
  // chainId 11155111, none elsewhere, e.g. local anvil). ORACLE_STRICT
  // makes a stale/unreachable oracle fail CLOSED instead of warn-only.
  oracleFeed: (env.ORACLE_FEED || "").trim(),
  oracleMaxDriftPct: num("ORACLE_MAX_DRIFT_PCT", 90),
  oracleMaxAgeHrs: num("ORACLE_MAX_AGE_HRS", 48),
  oracleStrict: bool("ORACLE_STRICT", false),

  // behaviour
  port: num("PORT", 8787),
  host: env.HOST || "127.0.0.1", // set HOST=0.0.0.0 when running on a VPS
  dryRun: bool("DRY_RUN", false),
  eventPoll: bool("EVENT_POLL", true),
  journalFile: resolve(AGENT_ROOT, env.JOURNAL_FILE || "data/journal.jsonl"),

  // demo faucet (hosted-judge quickstart, plan CP3 item 5)
  faucetEnabled: bool("FAUCET_ENABLED", true),
  faucetAmountUsdc: num("FAUCET_AMOUNT_USDC", 1000),
  faucetCooldownMin: num("FAUCET_COOLDOWN_MIN", 60),
  faucetDailyMax: num("FAUCET_DAILY_MAX", 24),

  // ── product mode (real-user accounts + per-user vaults) ───────────────────
  // AEGIS_MODE=judge (default) keeps the single demo vault of CP2/CP3 exactly
  // as shipped. AEGIS_MODE=product turns the agent into a multi-user service:
  // email/password accounts, per-user embedded wallets (encrypted keystores),
  // a per-user AegisVault deployed on signup, and Postgres persistence.
  aegisMode: (env.AEGIS_MODE || "judge").toLowerCase(), // judge | product
  productMode: (env.AEGIS_MODE || "judge").toLowerCase() === "product",
  databaseUrl: env.DATABASE_URL || "", // Postgres (Neon/Docker). Empty = in-memory store.
  serverSecret: env.AEGIS_SERVER_SECRET || "", // relayer envelope key for embedded wallets
  sessionTtlHours: num("SESSION_TTL_HOURS", 168),
  usdcSeedAmount: num("USDC_SEED_AMOUNT", 5000), // tUSDC minted into each new vault
  ethSeedAmount: num("ETH_SEED_AMOUNT", 0.05), // native ETH seeded into each new vault
  gasStipendEth: num("GAS_STIPEND_ETH", 0.003), // owner-op gas money sent to each user key
  productUsdcMaxPerTx: num("PRODUCT_USDC_MAX_PER_TX", 1000),
  productUsdcDaily: num("PRODUCT_USDC_DAILY", 2500),
  productEthMaxPerTx: num("PRODUCT_ETH_MAX_PER_TX", 0.05),
  productEthDaily: num("PRODUCT_ETH_DAILY", 0.2),
  keepaliveUrl: env.KEEPALIVE_URL || "", // e.g. dashboard URL — pings keep free tiers awake
  demoEmail: (env.DEMO_EMAIL || "demo@aegis.app").toLowerCase(),
  demoPassword: env.DEMO_PASSWORD || "aegis-demo-2026",
};

export const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * Exact human-units -> base-units conversion (string math, no float error).
 * toBaseUnits(0.2, 18) === 200000000000000000n exactly.
 */
export function toBaseUnits(amountHuman, decimals) {
  const [int = "0", frac = ""] = String(amountHuman).split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/** Base units -> human string, exact. */
export function fromBaseUnits(baseUnits, decimals) {
  const b = BigInt(baseUnits);
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** Token metadata resolved at runtime (address, symbol, decimals). */
export const tokens = {
  USDC: { symbol: "USDC", address: config.usdc, decimals: 6 },
  ETH: { symbol: "ETH", address: NATIVE, decimals: 18 },
};

export function tokenByAddress(addr) {
  const a = (addr || "").toLowerCase();
  if (a === NATIVE) return tokens.ETH;
  if (a === (config.usdc || "").toLowerCase()) return tokens.USDC;
  return null;
}
