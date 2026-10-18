// Task 25 verification — the user's exact console session, live on a product
// stack: the 4 Banglish commands from the bug report + balance visibility.
//
// Run AFTER the stack is up (anvil + deploy + agent in product mode):
//   AGENT_URL=http://127.0.0.1:8787 node scripts/v34-user-session-test.mjs
const BASE = (process.env.AGENT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const email = `v34-${Date.now()}@test.local`;
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
    signal: AbortSignal.timeout(45_000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

console.log(`v3.4 user-session test against ${BASE}`);

/* 1 ── /health carries the build version */
{
  const { data } = await api("/health");
  ok(data.version === "v3.4", "/health reports version v3.4", `got ${data.version}`);
}

/* 2 ── signup + wait for provisioning */
let token;
{
  const r = await api("/auth/signup", { method: "POST", body: { email, password, name: "Banglish Tester" } });
  ok(r.status === 201 && r.data.token, "signup returns a session token");
  token = r.data.token;
  const deadline = Date.now() + 180_000;
  let state = "";
  while (Date.now() < deadline) {
    const p = await api("/me/provision", { token });
    state = p.data?.vault?.state;
    if (state === "done" || state === "error") break;
    await new Promise((r2) => setTimeout(r2, 2_000));
  }
  ok(state === "done", "vault provisioned", `state=${state}`);
}

/* 3 ── /me exposes per-wallet balances */
{
  const { data } = await api("/me", { token });
  const wb = data.walletBalances || {};
  ok(!!wb.primary?.address, "/me lists the primary wallet");
  ok(!!wb.savings?.address, "/me lists the savings wallet");
  ok(typeof wb.savings?.usdc === "string", `savings USDC balance present (${wb.savings?.usdc})`);
  ok(Number(wb.savings?.usdc) === 0, "savings starts at 0 (fresh account)");
}

/* 4 ── the user's four console commands, verbatim */
let savingsBefore = null;
{
  const cmds = [
    ["kire ki khobor", "clarify", /Ki khobor!|any language/i],
    ["amr savings theke 10 usd landlord ke pathao", "clarify", /Your payees: Savings/i],
    ["amr savings e 10 usd ano", "execute", null],
    ["100 doller amr saving e pathao", "execute", null],
  ];
  for (const [text, want, re] of cmds) {
    const r = await api("/me/command", { method: "POST", token, body: { text } });
    const d = r.data.decision;
    const msgOk = !re || re.test(r.data.explanation || "") || re.test(r.data.intent?.clarify || "");
    ok(d === want && msgOk, `"${text}" -> ${want}`, `got ${d}: ${(r.data.explanation || r.data.intent?.clarify || "").slice(0, 120)}`);
  }
}

/* 5 ── money actually landed in the savings wallet + query sees it */
{
  const { data } = await api("/me", { token });
  const sav = Number(data.walletBalances?.savings?.usdc);
  ok(sav === 110, `savings wallet now holds 110 USDC (10+100)`, `got ${sav}`);
  const q = await api("/me/command", { method: "POST", token, body: { text: "how much money do I have in my wallets?" } });
  ok(q.data.decision === "query" && /Savings wallet: 110 USDC/.test(q.data.explanation),
    "balance query reports the savings wallet", q.data.explanation?.slice(0, 200));
  const q2 = await api("/me/command", { method: "POST", token, body: { text: "amr savings e koto taka ache?" } });
  ok(q2.data.decision === "query" && /Savings wallet/.test(q2.data.explanation),
    "Banglish balance query also reports wallets", q2.data.explanation?.slice(0, 200));
}

/* 6 ── activity feed recorded the whole session */
{
  const { data } = await api("/me/activity", { token });
  ok((data.activities || []).length >= 4, "activity feed has the session", `${data.activities?.length} entries`);
}

console.log(`\nv3.4 user-session: ${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
