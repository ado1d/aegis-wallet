// Oracle — the independent price check for swap quotes (v3.9.5).
//
// The swap venue (MockSwap) is a fixed-rate counterparty: its owner sets the
// rate by hand and the agent previously believed it with zero verification.
// A fat-fingered or quietly skewed rate would execute every user swap at a
// wrong price — exactly the trust problem Aegis exists to solve. This module
// reads the Chainlink ETH/USD feed (a public, owner-less price source) and
// compares it against what the venue's quote actually implies.
//
// Enforcement is two-tier, both visible to the user:
//   * HARD: |implied price - oracle price| > ORACLE_MAX_DRIFT_PCT -> the swap
//     is refused before any money moves ("off-market"). Default 90% catches
//     broken configurations (wrong decimals, transposed digits, a venue
//     pointed at a stale pair) while tolerating the Sepolia demo venue's
//     intentionally fixed rate. Production or a market-tracking venue: 2-5%.
//   * SOFT: any drift >= 1% that passes the band is DISCLOSED in the swap
//     reply ("venue implies $X/ETH, Chainlink says $Y/ETH"), so nobody swaps
//     at an off-market rate without seeing it in writing.
//
// A missing feed (local anvil, other chains), a stale answer, or an RPC
// hiccup degrades to warn-only unless ORACLE_STRICT=true (fail closed for
// deployments that want the check mandatory).

import { ethers } from "ethers";
import { config } from "./config.js";

/** Chainlink ETH/USD AggregatorV3 on Sepolia (public testnet feed, 8 decimals). */
export const SEPOLIA_ETH_USD = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint256 answeredInRound)",
];

// 30s in-process cache: one serverless warm instance serves a burst of quotes
// with a single feed read instead of hammering the RPC per message.
let priceCache = { at: 0, value: null };

/** Resolve which feed to use. Explicit ORACLE_FEED wins; otherwise the known
 *  Sepolia default when the connected chain is Sepolia; anything else
 *  (anvil, unknown chains) = no oracle, the check reports itself skipped. */
async function resolveFeed(provider) {
  if (config.oracleFeed) return config.oracleFeed;
  try {
    const { chainId } = await provider.getNetwork();
    if (chainId === 11155111n) return SEPOLIA_ETH_USD;
  } catch { /* provider unreachable — reported by the caller's catch */ }
  return "";
}

/** Live ETH/USD price from Chainlink. Never throws on the happy path;
 *  returns a structured result the caller can act on:
 *    { skipped }                  - no feed for this chain
 *    { feed, priceUsd, updatedAt, ageHrs, stale }
 *    { error }                    - feed unreachable (warn / strict-reject) */
export async function ethUsdPrice(provider) {
  const feed = await resolveFeed(provider);
  if (!feed) return { skipped: "no oracle feed configured for this chain" };
  if (priceCache.value && Date.now() - priceCache.at < 30_000) {
    return priceCache.value;
  }
  try {
    const agg = new ethers.Contract(feed, AGGREGATOR_ABI, provider);
    const r = await agg.latestRoundData();
    const priceUsd = Number(r.answer) / 1e8;
    if (!(priceUsd > 0)) return { error: "the oracle returned a non-positive price" };
    const ageHrs = Math.max(0, (Date.now() / 1000 - Number(r.updatedAt)) / 3600);
    const out = {
      feed,
      priceUsd,
      updatedAt: Number(r.updatedAt),
      ageHrs: Math.round(ageHrs * 100) / 100,
      stale: ageHrs > config.oracleMaxAgeHrs,
    };
    priceCache = { at: Date.now(), value: out };
    return out;
  } catch (err) {
    return { error: String(err?.shortMessage || err?.message || err).slice(0, 160) };
  }
}

/** Test seam: drop the 30s cache between scenarios. */
export function _clearPriceCache() {
  priceCache = { at: 0, value: null };
}

/** Pure price sanity: what does the venue's quote imply vs the oracle?
 *  Works both directions (mock USDC is treated as $1, the assumption the
 *  whole demo shares):
 *    USDC -> ETH: implied $/ETH = sellAmount / expectedOut
 *    ETH -> USDC: implied $/ETH = expectedOut / sellAmount
 *  Returns { ok, verdict, impliedUsdPerEth, oracleUsdPerEth, driftPct, maxDriftPct }.
 *  ok=false means OFF-MARKET (|drift| beyond the band) or an unusable quote. */
export function venueRateSanity(quote, oracleUsd, maxDriftPct = config.oracleMaxDriftPct) {
  const band =
    Number.isFinite(maxDriftPct) && maxDriftPct > 0 ? maxDriftPct : 90;
  if (!Number.isFinite(oracleUsd) || !(oracleUsd > 0)) {
    return { ok: true, verdict: "skipped", reason: "no oracle price to compare against" };
  }
  const sell = Number(quote?.sellAmountHuman);
  const out = Number(quote?.expectedOutHuman);
  if (!(sell > 0) || !(out > 0)) {
    return {
      ok: false,
      verdict: "off-market",
      reason: "the quote does not carry positive amounts on both sides",
      impliedUsdPerEth: null,
      oracleUsdPerEth: oracleUsd,
      driftPct: null,
      maxDriftPct: band,
    };
  }
  const implied = quote.buySymbol === "ETH" ? sell / out : out / sell;
  const driftPct = ((implied - oracleUsd) / oracleUsd) * 100;
  const off = Math.abs(driftPct) > band;
  return {
    ok: !off,
    verdict: off ? "off-market" : "within",
    impliedUsdPerEth: Math.round(implied * 100) / 100,
    oracleUsdPerEth: Math.round(oracleUsd * 100) / 100,
    driftPct: Math.round(driftPct * 10) / 10,
    maxDriftPct: band,
  };
}

/** One-line disclosure for allowed swaps whose rate differs from the market
 *  (>= 1%): shown verbatim in the swap reply. Returns "" when silent. */
export function oracleDisclosure(sanity) {
  if (!sanity || !Number.isFinite(sanity.driftPct)) return "";
  if (Math.abs(sanity.driftPct) < 1) return "";
  const dir = sanity.driftPct > 0 ? "above" : "below";
  return (
    ` Reference price: Chainlink ETH/USD $${sanity.oracleUsdPerEth.toFixed(2)}; ` +
    `this venue's fixed rate implies $${sanity.impliedUsdPerEth.toFixed(2)} per ETH ` +
    `(${Math.abs(sanity.driftPct).toFixed(1)}% ${dir} market).`
  );
}
