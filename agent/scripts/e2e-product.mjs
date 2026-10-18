// Product-mode end-to-end acceptance — the "real user" journey, live on a chain.
//
// Prereqs:  anvil (or any chain) with MockUSDC + MockSwap deployed; the agent
//           running in product mode:
//             AEGIS_MODE=product AEGIS_SERVER_SECRET=... AGENT_KEY=... \
//             USDC_ADDRESS=... VENUE_ADDRESS=... node src/server.js
//
// Run:      npm run e2e:product
//           AGENT_URL=http://127.0.0.1:8787 npm run e2e:product
//
// Exercises: signup -> provisioning -> autonomous pay -> over-cap queue ->
// owner approval from the EMBEDDED key -> swap -> whitelist floor -> payee
// management -> tighter limits -> kill switch -> resume -> activity feed ->
// notifications -> self-custody key export -> login.

const BASE = (process.env.AGENT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const email = `e2e-${Date.now()}@test.local`;
const password = "correct horse battery staple";

let passed = 0, failed = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label} ${extra}`); }
};

const api = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000), // a hung request must FAIL, not block the run
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

console.log(`product e2e against ${BASE}`);

/* 1 ── health is product mode */
{
  const { data } = await api("/health");
  ok(data.mode === "product", "agent boots in product mode", `got ${data.mode}`);
}

/* 2 ── signup provisions a vault (wait for the whole pipeline) */
let token, me;
{
  const r = await api("/auth/signup", { method: "POST", body: { email, password, name: "E2E Tester" } });
  ok(r.status === 201 && r.data.token, "signup returns a session token", JSON.stringify(r.data).slice(0, 120));
  token = r.data.token;
  if (!token) process.exit(1);

  const deadline = Date.now() + 180_000;
  let state = "";
  while (Date.now() < deadline) {
    const p = await api("/me/provision", { token });
    state = p.data?.vault?.state;
    if (state === "done" || state === "error") break;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  ok(state === "done", "provisioning pipeline completes (deploy→configure→transfer→seed)", `state=${state}`);

  me = (await api("/me", { token })).data;
  ok(me.vault?.address, `per-user vault at ${me.vault?.address}`);
  ok(me.wallets?.primary && me.wallets?.savings, "embedded wallets created");
  const usdc = Number(me.state?.tokens?.USDC?.vaultBalance || 0) / 1e6;
  ok(usdc >= 4900, `vault seeded with tUSDC (balance ${usdc.toLocaleString()})`);
  ok(me.state?.whitelist?.some((w) => w.label === "Savings"), "Savings payee whitelisted at birth");
}

/* 3 ── autonomous execution inside the envelope */
{
  const r = await api("/me/command", { method: "POST", token, body: { text: "move 100 usdc to savings" } });
  ok(r.data.decision === "execute", `"move 100 usdc to savings" executes autonomously`, `got ${r.data.decision}: ${r.data.explanation?.slice(0, 100)}`);
  ok(!!r.data.tx?.agentExecute, "on-chain tx hash returned");
}

/* 4 ── over-cap payment queues; the USER's key approves it */
{
  const r = await api("/me/command", { method: "POST", token, body: { text: "pay savings 1500 usdc" } });
  ok(r.data.decision === "queue", "over-cap payment queues for the human", `got ${r.data.decision}`);
  const id = r.data.queuedId;
  ok(id != null, `queued with id #${id}`);

  const a = await api(`/me/approvals/${id}/approve`, { method: "POST", token });
  ok(a.data?.result?.executeApprovedTx?.ok === true, "owner approval executes from the embedded key",
     JSON.stringify(a.data?.result?.executeApprovedTx || {}).slice(0, 140));
}

/* 5 ── swaps through the shared venue */
{
  const r = await api("/me/command", { method: "POST", token, body: { text: "swap 200 usdc to eth" } });
  ok(r.data.decision === "swap", '"swap 200 usdc to eth" executes', `got ${r.data.decision}: ${r.data.explanation?.slice(0, 100)}`);
}

/* 6 ── whitelist floor: unknown explicit address is refused; unknown label asks */
{
  const r = await api("/me/command", { method: "POST", token, body: { text: "send 200 usdc to 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" } });
  ok(r.data.decision === "reject", "unlisted explicit address refused (whitelist floor)", `got ${r.data.decision}`);
  const cl = await api("/me/command", { method: "POST", token, body: { text: "pay landlord 200 usdc" } });
  ok(cl.data.decision === "clarify", "unknown payee label asks instead of guessing", `got ${cl.data.decision}`);
}

/* 7 ── the user whitelists their own payee (owner op from embedded key) */
{
  const r = await api("/me/payees", {
    method: "POST", token,
    body: { label: "Landlord", address: "0x90f79BF6eB2C4f8443659171c71522320EB20889", category: "rent" },
  });
  ok(r.status === 200, 'payee "Landlord" whitelisted', JSON.stringify(r.data).slice(0, 140));
  const p = await api("/me/command", { method: "POST", token, body: { text: "pay landlord 200 usdc" } });
  ok(p.data.decision === "execute", '"pay landlord 200 usdc" now executes', `got ${p.data.decision}`);
}

/* 8 ── tighter limits, then kill switch */
{
  const r = await api("/me/policy", { method: "POST", token, body: { symbol: "USDC", maxPerTx: 50, dailyLimit: 100 } });
  ok(r.status === 200 && r.data.result?.ok !== false, "user tightens USDC limits from their key");

  const q = await api("/me/command", { method: "POST", token, body: { text: "pay landlord 60 usdc" } });
  ok(q.data.decision === "queue", "payment above the new cap queues", `got ${q.data.decision}`);

  const pause = await api("/me/agent/pause", { method: "POST", token });
  ok(pause.status === 200, "kill switch engaged by the user");
  const blocked = await api("/me/command", { method: "POST", token, body: { text: "pay landlord 5 usdc" } });
  ok(blocked.data.decision === "reject", "while paused, even tiny payments are refused", `got ${blocked.data.decision}`);
  const resume = await api("/me/agent/resume", { method: "POST", token });
  ok(resume.status === 200, "agent resumed");
}

/* 9 ── product feeds + self-custody export + login */
{
  const act = await api("/me/activity", { token });
  ok((act.data.activities || []).length >= 8, `activity feed has ${(act.data.activities || []).length} entries`);
  const notes = await api("/me/notifications", { token });
  ok((notes.data.notifications || []).some((n) => n.kind === "approval"), "approval notification raised");
  const exp = await api("/me/export-key", { method: "POST", token, body: { password } });
  ok(exp.status === 200 && exp.data.address === me.wallets.primary, "self-custody key export decrypts with the password");
  const expBad = await api("/me/export-key", { method: "POST", token, body: { password: "wrong-password" } });
  ok(expBad.status === 401, "export refuses a wrong password");
  const login = await api("/auth/login", { method: "POST", body: { email, password } });
  ok(login.status === 200 && login.data.token, "login works after signup");
  const out = await api("/auth/logout", { method: "POST", token: login.data.token });
  ok(out.status === 200, "logout works");
}

console.log(`\nproduct e2e: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
