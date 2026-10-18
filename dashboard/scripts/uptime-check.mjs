#!/usr/bin/env node
// Synthetic uptime check for a deployed Aegis agent. Runs from GitHub Actions
// (see .github/workflows/uptime.yml) or manually:
//   AGENT_URL=https://your-agent-host node dashboard/scripts/uptime-check.mjs
// Exit code 0/1 makes it CI-friendly; a workflow that stays red for two
// consecutive runs means the demo is down.
//
// Works for both agent modes:
//   - judge mode (single shared vault): checks /health + /state + /approvals
//   - product mode (accounts + per-user vaults): checks /health and verifies
//     the auth perimeter rejects requests without a session token

const BASE = (process.env.AGENT_URL || "").replace(/\/$/, "");
if (!BASE) {
  // No AGENT_URL configured: nothing is being monitored, so there is nothing
  // to fail. Set the secret in repo Settings -> Secrets -> Actions to arm it.
  console.log("SKIP  AGENT_URL secret not set; set it to the deployed agent URL to arm this check");
  process.exit(0);
}
const t0 = Date.now();
const fail = (m) => { console.log(`FAIL  ${m}`); process.exit(1); };
const get = (path) => fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) });

try {
  const health = await get("/health").then((r) => r.json());
  if (health.ok !== true) fail("/health not ok");
  const mode = health.mode || "judge";
  const facts = [`mode ${mode}`, `v${health.version || "?"}`];
  if (health.llm) facts.push(`llm ${health.llm.breaker || "n/a"}`);

  if (mode === "product") {
    const stats = health.stats || {};
    facts.push(`users ${stats.users ?? "?"}`, `vaults ${stats.vaultsDone ?? "?"}`);
    // the auth perimeter must reject anonymous access to /me
    const me = await get("/me");
    if (me.status === 200) fail("/me answered WITHOUT a session token (auth perimeter broken)");
    if (![401, 403].includes(me.status)) fail(`/me returned ${me.status}, expected 401/403`);
  } else {
    const state = await get("/state").then((r) => r.json());
    if (!["Active", "Paused", "Revoked"].includes(state.agentStatusName)) fail(`agent status odd: ${state.agentStatusName}`);
    if (!state.tokens?.USDC) fail("USDC state missing (RPC or env problem)");
    const balance = Number(state.tokens.USDC.vaultBalance) / 1e6;
    if (balance < 100) fail(`demo vault low on USDC (${balance})`);
    const approvals = await get("/approvals").then((r) => r.json());
    if (!Array.isArray(approvals.pending)) fail("approvals queue unreadable");
    facts.push(`USDC ${balance.toLocaleString()}`, `queue ${approvals.pending.length}`);
  }

  console.log(`OK    agent healthy (${facts.join(", ")}) in ${Date.now() - t0} ms`);
} catch (e) {
  fail(`unreachable or errored: ${e.message}`);
}
