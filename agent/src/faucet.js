// Demo faucet — CP3 work item 5 (judge quickstart) with explicit guard rails:
//   * per-address cooldown (default 60 min) — repeated claims are refused
//   * global daily cap (default 24 claims/day) — a crowd cannot drain the demo
//   * fixed claim size (default 1,000 mock USDC per claim)
// The claim ledger is in-memory: restarting the agent resets it (documented) —
// acceptable for a demo whose asset is MockUSDC (worthless outside the demo).
//
// MockUSDC.mint is open by design (demo asset); THIS module is the agent's
// only mint path, and it is rate-limited here.

import { config } from "./config.js";
import { mintMockUsdc } from "./chain.js";

const claims = new Map(); // address (lowercase) -> last-claim timestamp
let dailyDay = dayKey(Date.now());
let dailyCount = 0;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function rollDay(now) {
  const k = dayKey(now);
  if (k !== dailyDay) {
    dailyDay = k;
    dailyCount = 0;
  }
}

export function faucetStatus() {
  return {
    enabled: config.faucetEnabled,
    amountUsdc: safeFaucetAmount(),
    cooldownMin: config.faucetCooldownMin,
    dailyMax: config.faucetDailyMax,
    claimsToday: dailyCount,
    token: "USDC (mock)",
  };
}

// the claim size feeds BigInt() — a bad config value falls back to the
// default instead of crashing the mint with BigInt(NaN)
function safeFaucetAmount() {
  return Number.isFinite(config.faucetAmountUsdc) && config.faucetAmountUsdc > 0
    ? Math.round(config.faucetAmountUsdc)
    : 1000;
}

/**
 * Claim mock USDC for an address.
 * @returns {Promise<{ok:boolean, error?:string, tx?:string, retryInMin?:number,
 *                    amountUsdc?:number, simulated?:boolean, claimsToday?:number}>}
 */
export async function faucetClaim(address) {
  if (!config.faucetEnabled) return { ok: false, error: "faucet is disabled (FAUCET_ENABLED=false)" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
    return { ok: false, error: "address must be 0x…40 hex" };
  }

  const now = Date.now();
  rollDay(now);
  if (dailyCount >= config.faucetDailyMax) {
    return {
      ok: false,
      error: `daily cap reached (${config.faucetDailyMax} claims/day); the demo resets nightly`,
      claimsToday: dailyCount,
    };
  }

  const a = address.toLowerCase();
  const cooldownMs = config.faucetCooldownMin * 60_000;
  const last = claims.get(a) || 0;
  if (now - last < cooldownMs) {
    const left = Math.ceil((cooldownMs - (now - last)) / 60_000);
    return {
      ok: false,
      error: `cooldown active for this address, try again in ${left} min`,
      retryInMin: left,
    };
  }

  if (config.dryRun) {
    claims.set(a, now);
    dailyCount++;
    return { ok: true, simulated: true, tx: "dry-run", amountUsdc: safeFaucetAmount(), claimsToday: dailyCount };
  }

  const res = await mintMockUsdc(address, BigInt(safeFaucetAmount() * 1e6));
  if (!res.ok) return { ok: false, error: `mint failed: ${res.revert}` };

  claims.set(a, now);
  dailyCount++;
  return {
    ok: true,
    tx: res.hash,
    amountUsdc: safeFaucetAmount(),
    claimsToday: dailyCount,
  };
}
