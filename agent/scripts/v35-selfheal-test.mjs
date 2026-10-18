// v3.5 self-heal regression — proves the chain-reset bug is dead.
//
// THE BUG (user report): after anvil was restarted, Postgres still held the
// old per-user vault address; the first command died with
//   [500] POST /me/command: could not decode result data (value="0x",
//        info={ "method": "agentStatus", … }, code=BAD_DATA)
// and the dashboard showed no money. Root cause: the vault address had no
// contract code on the fresh chain.
//
// THE FIX: userChainContext() detects a code-less vault and re-provisions it
// in-place (deploy → configure → transfer → seed), and a boot-time sweep
// (provision.healStaleVaults) re-provisions stale vaults at agent start.
//
// Run against a live stack (see scripts/v35-live-verify.sh for the full
// lifecycle, including the anvil restart between phases):
//
//   node scripts/v35-selfheal-test.mjs phase1   # fresh chain: signup + Banglish commands
//   node scripts/v35-selfheal-test.mjs phase2   # AFTER anvil reset + CP1 redeploy
//
// Phase 2 is the regression: same agent process, dead vault on chain — the
// command must self-heal and answer instead of 500ing.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(HERE, "../data/v35-state.json");
const BASE = process.env.AEGIS_URL || "http://127.0.0.1:8787";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${extra && !cond ? ` — ${extra}` : ""}`);
  cond ? pass++ : fail++;
};

async function api(path, { method = "GET", token, body, timeoutMs = 60000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function waitProvisioned(token, maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await api("/me/provision", { token });
    if (r.data?.vault?.state === "done") return true;
    if (r.data?.vault?.state === "error") return false;
    await sleep(1500);
  }
  return false;
}

async function command(token, text) {
  return api("/me/command", { method: "POST", token, body: { text }, timeoutMs: 90000 });
}

/* ── phase 1: fresh chain, fresh account ─────────────────────────────────── */
async function phase1() {
  console.log("\n━━━ v3.5 phase 1 — fresh stack: signup + Banglish commands ━━━");

  const h = await api("/health");
  ok(h.status === 200 && h.data?.version === "v3.5", `/health reports build v3.5 (got ${h.data?.version})`);
  ok(h.data?.mode === "product", "agent runs in product mode");
  console.log(`  · intent provider: ${h.data?.llmProvider} → ${h.data?.llmProviderResolved}`);

  const email = `v35-${Date.now()}@test.aegis`;
  const password = "correct horse battery staple";
  const su = await api("/auth/signup", { method: "POST", body: { email, password, name: "Self-Heal Test" } });
  ok(su.status === 201 && su.data?.token, "signup returns a session token");
  const token = su.data?.token;
  if (!token) return done();

  ok(await waitProvisioned(token), "vault provisioned (deploy → configure → transfer → seed)");

  const me = await api("/me", { token });
  ok(me.status === 200 && me.data?.state?.agentStatusName === "Active", "/me: agent Active on the vault");
  ok(!!me.data?.walletBalances?.primary && !!me.data?.walletBalances?.savings, "/me: primary + savings wallet balances present");
  const seed = Number(me.data?.state?.tokens?.USDC?.vaultBalance) / 1e6;
  ok(seed >= 4999, `vault seeded with USDC (${seed})`);
  console.log(`  · wallets: primary ${me.data?.wallets?.primary?.slice(0, 10)}… savings ${me.data?.wallets?.savings?.slice(0, 10)}…`);

  const g = await command(token, "hello, kemn achen");
  ok(g.status === 200 && g.data?.decision, `greeting answered (decision=${g.data?.decision}, was 500 before v3.5)`);
  ok(!/decode result data/i.test(String(g.data?.error || "")), "no BAD_DATA decode error");

  const dep = await command(token, "amr savings e 10 usd ano");
  ok(dep.status === 200 && dep.data?.decision === "execute", `"amr savings e 10 usd ano" executed (got ${dep.data?.decision})`);

  const me2 = await api("/me", { token });
  const sav = Number(me2.data?.walletBalances?.savings?.usdc);
  ok(sav === 10, `money visible in the savings wallet (${sav} USDC)`);

  const q = await command(token, "amr koto taka ache?");
  ok(q.status === 200 && q.data?.decision === "query", "balance query (Banglish) answered");
  ok(/Wallets\s*—/i.test(String(q.data?.explanation)), "answer lists every wallet's balance");

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ email, password }, null, 2));
  console.log(`  · session saved for phase 2 (${STATE_FILE})`);
  done();
}

/* ── phase 2: anvil was wiped + CP1 redeployed; agent process NEVER restarted ── */
async function phase2() {
  console.log("\n━━━ v3.5 phase 2 — chain reset underneath a RUNNING agent ━━━");
  console.log("  (this exact scenario 500'd with BAD_DATA before v3.5)");

  if (!existsSync(STATE_FILE)) {
    console.error("  ✗ no phase-1 state — run `node scripts/v35-selfheal-test.mjs phase1` first");
    return done();
  }
  const { email, password } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const li = await api("/auth/login", { method: "POST", body: { email, password } });
  ok(li.status === 200 && li.data?.token, "existing account still logs in");
  const token = li.data?.token;
  if (!token) return done();

  const t0 = Date.now();
  const g = await command(token, "hello, kemn achen");
  const ms = Date.now() - t0;
  ok(g.status === 200 && g.data?.decision, `first command after reset self-healed and answered in ${ms} ms (was HTTP 500)`);
  ok(!/decode result data/i.test(String(g.data?.error || "")), "no BAD_DATA decode error");

  const me = await api("/me", { token });
  ok(me.data?.state?.agentStatusName === "Active", "/me: vault live again, agent Active");
  const seed = Number(me.data?.state?.tokens?.USDC?.vaultBalance) / 1e6;
  ok(seed >= 4999, `vault re-seeded after heal (${seed} USDC)`);
  ok(me.data?.vault?.state === "done", "vault state back to done");

  const dep = await command(token, "100 doller amr saving e pathao");
  ok(dep.status === 200 && dep.data?.decision === "execute", `"100 doller amr saving e pathao" executed (got ${dep.data?.decision})`);

  const me2 = await api("/me", { token });
  const sav = Number(me2.data?.walletBalances?.savings?.usdc);
  ok(sav === 100, `savings wallet shows the money again (${sav} USDC)`);

  done();
}

function done() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} v3.5 self-heal test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

const phase = process.argv[2] || "phase1";
if (phase === "phase1") await phase1();
else if (phase === "phase2") await phase2();
else {
  console.error("usage: node scripts/v35-selfheal-test.mjs phase1|phase2");
  process.exit(2);
}
