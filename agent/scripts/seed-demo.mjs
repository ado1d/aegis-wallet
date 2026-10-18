// npm run seed:demo — create/refresh the one-click demo account on a RUNNING
// product-mode agent (works against both the in-memory and Postgres stores,
// because it goes through the real HTTP product API — the same path users do).
//
//   AEGIS_MODE=product node src/server.js        # terminal A
//   npm run seed:demo                            # terminal B
//
// Optional env: AGENT_URL, DEMO_PAYEE_ADDRESS (a "Landlord" payee to whitelist).

import { config } from "../src/config.js";

const BASE = (process.env.AGENT_URL || `http://127.0.0.1:${config.port}`).replace(/\/$/, "");
const DEMO_PAYEE = process.env.DEMO_PAYEE_ADDRESS || "0x90f79BF6eB2C4f8443659171c71522320EB20889"; // anvil #5 locally

const api = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const log = (...a) => console.log(" ", ...a);

// 1 ── create (or reuse) the demo account
let r = await api("/auth/signup", {
  method: "POST",
  body: { email: config.demoEmail, password: config.demoPassword, name: "Demo User" },
});
let token = r.data?.token;
if (r.status === 409) {
  log("demo account already exists — logging in");
  r = await api("/auth/login", { method: "POST", body: { email: config.demoEmail, password: config.demoPassword } });
  token = r.data?.token;
}
if (!token) {
  console.error("seed failed:", r.status, r.data);
  process.exit(1);
}
log(`demo account ready: ${config.demoEmail}`);

// 2 ── wait for provisioning (vault deploy + config + ownership handover + seed)
const deadline = Date.now() + 10 * 60 * 1000;
let vault;
while (Date.now() < deadline) {
  const p = await api("/me/provision", { token });
  vault = p.data?.vault;
  if (vault?.state === "done") break;
  if (vault?.state === "error") {
    console.error("provisioning failed:", vault.error);
    process.exit(1);
  }
  process.stdout.write(`  provisioning: ${vault?.state || "pending"}…\r`);
  await new Promise((ok) => setTimeout(ok, 3000));
}
if (vault?.state !== "done") {
  console.error("provisioning timed out");
  process.exit(1);
}
log(`vault live: ${vault.address}`);

// 3 ── give the demo account a payee + one real history entry
const payee = await api("/me/payees", {
  method: "POST",
  token,
  body: { label: "Landlord", address: DEMO_PAYEE, category: "rent" },
});
log(payee.status === 200 ? 'payee "Landlord" whitelisted' : `payee step: ${payee.status} ${payee.data?.error || ""}`);

const cmd = await api("/me/command", { method: "POST", token, body: { text: "move 100 usdc to savings" } });
log(`history seed: "move 100 usdc to savings" -> ${cmd.data?.decision} ${cmd.data?.tx?.agentExecute ? `(tx ${cmd.data.tx.agentExecute.slice(0, 18)}…)` : ""}`);

// 4 ── summary
const me = await api("/me", { token });
log("balances : USDC " + (Number(me.data?.state?.tokens?.USDC?.vaultBalance || 0) / 1e6).toLocaleString() +
    " · ETH " + (Number(me.data?.state?.tokens?.ETH?.vaultBalance || 0) / 1e18).toFixed(4));
log("done — judges can now click \"Try the demo\" on the landing page.");
