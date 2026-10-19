// Aegis agent HTTP API — zero-framework (node:http), two dependencies
// (ethers, and pg+bcryptjs in product mode).
//
// ── JUDGE MODE (default, CP2/CP3/CP4 semantics — unchanged) ────────────────
//   GET  /health                       liveness + config summary
//   GET  /state                        full vault snapshot (policy mirror input)
//   POST /command                      {"text": "..."} -> decision trace
//   GET  /history?limit=20             recent decisions (journal)
//   GET  /approvals                    pending owner queue (on-chain truth)
//   POST /approvals/{id}/approve       owner: approve + execute
//   POST /approvals/{id}/reject        owner: reject (auto-logged on-chain)
//   GET  /rejections?limit=20          on-chain rejection ledger
//   GET  /quote?sell=USDC&buy=ETH&amount=100
//   POST /owner/pause | /owner/resume  kill switch (owner key)
//   POST /whitelist                    {"address":"0x..","label":".."} (owner)
//   GET  /faucet/status                faucet config + claims today (CP3)
//   POST /faucet/claim                 {"address":"0x.."} mock-USDC, rate-limited
//
// ── PRODUCT MODE (AEGIS_MODE=product — real users, per-user vaults) ────────
//   POST /auth/signup {email,password,name}   -> {token,user} + async provisioning
//   POST /auth/login  {email,password}        -> {token,user}
//   POST /auth/logout
//   POST /auth/demo                           -> one-click demo account login
//   GET  /me                                  -> profile + vault + balances
//   GET  /me/provision                        -> live provisioning status
//   POST /me/command {text}                   -> decision trace (user's vault)
//   POST /me/help {text,history?}              -> guidance ONLY, never acts
//   GET  /me/approvals | /me/rejections       -> user's queue / ledger
//   POST /me/approvals/{id}/approve|reject    -> owner ops via embedded wallet
//   POST /me/payees {label,address,category}  -> whitelist a payee (owner op)
//   DEL  /me/payees?address=0x..
//   POST /me/policy {symbol,maxPerTx,dailyLimit}
//   POST /me/agent/pause | /me/agent/resume   -> kill switch (user's key)
//   POST /me/withdraw {symbol,to,amount}      -> sovereign ownerWithdraw
//   GET  /me/activity | /me/notifications     -> product feed
//   POST /me/notifications/{id}/read
//   POST /me/export-key {password}            -> self-custody export
//   POST /me/faucet                           -> top up test USDC (cooldown)
//   GET  /quote?sell=&buy=&amount=            -> swap quote (shared venue)

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { config, configWarnings, tokens, toBaseUnits, AGENT_VERSION } from "./config.js";
import { llmPreflight, llmStatus } from "./llm.js";
import * as chain from "./chain.js";
import { processCommand, ownerActions, summarizeState } from "./executor.js";
import { decisions } from "./journal.js";
import { faucetStatus, faucetClaim } from "./faucet.js";
import { initStore, getStore } from "./store.js";
import * as auth from "./auth.js";
import { provisionUser, resumePending, healStaleVaults } from "./provision.js";
import { userChainContext, meView, recordDecision, recordOwnerOp, walletBalancesView, walletBalancesLine } from "./uservault.js";
import { helpAnswer, sanitizeHelpHistory } from "./help.js";
import { startKeepalive } from "./keepalive.js";

/* ═══════════════════════════════════════════════════════════════════════════
   Serverless hosting surface (v3.9 — Vercel)

   The same zero-framework handler runs as a long-lived node:http server
   (`startServer`, unchanged for local/Render runs) or as ONE Vercel Node
   function (`api/index.js` rewrites every path here). Two hosting-specific
   concerns are handled centrally:

   bg(promise) — work that must outlive the HTTP response (vault
   provisioning after signup). On a long-running server it is a detached
   promise; on Vercel it is handed to waitUntil() so the invocation is not
   frozen mid-pipeline. If the instance is still frozen/reaped, the pipeline
   is idempotent and the next cold start's resumePending() + the
   /me/provision stuck-kick finish the job.

   bootForServerless() — idempotent cold-start boot (store init + banner +
   background resume/self-heal). keepalive/event-polling are skipped on
   Vercel: functions scale to zero, there is nothing to keep warm and no
   long-lived loop to host.
   ═══════════════════════════════════════════════════════════════════════════ */

let _waitUntil = null;
try {
  ({ waitUntil: _waitUntil } = await import("@vercel/functions"));
} catch {
  /* package absent or not on Vercel — detached promises are fine locally */
}

/** Fire-and-forget work that must survive past the response. */
export function bg(promise) {
  const p = Promise.resolve(promise).catch((e) => {
    console.error("  [bg]", String(e?.message || e).slice(0, 200));
  });
  if (_waitUntil) {
    try { _waitUntil(p); } catch { /* outside a request scope — detached */ }
  }
  return p;
}

const json = (res, code, body) => {
  const payload = JSON.stringify(body, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(payload);
};

async function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PRODUCT MODE routes
   ═══════════════════════════════════════════════════════════════════════════ */

async function requireUser(req) {
  const token = auth.bearer(req);
  if (!token) return { error: 401, message: "missing Authorization: Bearer <token>" };
  const s = await auth.sessionUser(token);
  if (!s) return { error: 401, message: "invalid or expired session, log in again" };
  return { user: s.user, token };
}

const faucetCooldown = new Map(); // userId -> last claim ms
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 normalize (users paste lowercase/mixed) — throws on garbage. */
const normAddr = (a) => ethers.getAddress(String(a || "").trim());

async function routeProduct(req, res, url) {
  const q = url.searchParams;
  const store = getStore();

  /* ── auth ─────────────────────────────────────────────────────────────── */

  if (req.method === "POST" && url.pathname === "/auth/signup") {
    const body = await readBody(req);
    const { email, password, name, problems } = auth.validateSignup(body);
    if (problems.length) return json(res, 400, { error: problems.join("; ") });
    if (await store.getUserByEmail(email)) return json(res, 409, { error: "that email is already registered, log in instead" });
    const user = await store.createUser({ email, name, passwordHash: await auth.hashPassword(password) });
    const wallets = await auth.createEmbeddedWallets(password); // ~2s scrypt x4
    await store.saveKeystores({ userId: user.id, ...wallets });
    await store.upsertVault({ userId: user.id, state: "pending" });
    const { token, expiresAt } = await auth.createSession(user.id);
    bg(provisionUser(user.id)); // async — dashboard polls /me/provision; waitUntil keeps it alive on serverless
    await store.addActivity({ userId: user.id, kind: "system", decision: "signup", explanation: "Account created. Provisioning your on-chain vault…" });
    return json(res, 201, { token, expiresAt, user: { id: user.id, email: user.email, name: user.name } });
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    if (!auth.throttleCheck(email)) return json(res, 429, { error: "too many failed attempts, try again in 15 minutes" });
    const user = await store.getUserByEmail(email);
    const ok = user && (await auth.verifyPassword(String(body.password || ""), user.passwordHash));
    if (!ok) { auth.throttleFail(email); return json(res, 401, { error: "wrong email or password" }); }
    auth.throttleReset(email);
    const { token, expiresAt } = await auth.createSession(user.id);
    return json(res, 200, { token, expiresAt, user: { id: user.id, email: user.email, name: user.name } });
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    await auth.logout(auth.bearer(req));
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/auth/demo") {
    const user = await store.getUserByEmail(config.demoEmail);
    if (!user) return json(res, 404, { error: "demo account not seeded on this deployment (npm run seed:demo)" });
    const { token, expiresAt } = await auth.createSession(user.id);
    return json(res, 200, { token, expiresAt, user: { id: user.id, email: user.email, name: user.name } });
  }

  /* ── everything below requires a session ──────────────────────────────── */

  const au = await requireUser(req);
  if (au.error) return json(res, au.error, { error: au.message });
  const user = au.user;

  if (req.method === "GET" && url.pathname === "/me") {
    return json(res, 200, await meView(user));
  }

  if (req.method === "GET" && url.pathname === "/me/provision") {
    const row = await store.getVault(user.id);
    // serverless freeze guard: if a vault has sat mid-pipeline for >3 min with
    // no in-flight work on THIS instance, the provisioning was frozen with its
    // invocation — re-queue it (idempotent pipeline, deduped per user).
    if (
      row && row.state !== "done" && row.state !== "error" &&
      Date.now() - new Date(row.updatedAt).getTime() > 180_000
    ) {
      bg(provisionUser(user.id));
    }
    return json(res, 200, { vault: row || { state: "pending" } });
  }

  // explicit retry — the dashboard's "Retry provisioning" button. Safe because
  // every pipeline step is idempotent (deploy checks code, configure checks
  // ownership, seeding checks balances); a done vault short-circuits. Without
  // this endpoint a vault in state "error" could NEVER be retried: the GET
  // stuck-kick above deliberately skips errored rows, so the old button (a
  // plain page reload) was a dead end.
  if (req.method === "POST" && url.pathname === "/me/provision") {
    const row = await store.getVault(user.id);
    if (row?.state === "done") return json(res, 200, { vault: row });
    if (row?.state === "error") {
      await store.upsertVault({ userId: user.id, state: "pending", error: null });
    }
    bg(provisionUser(user.id));
    return json(res, 202, { vault: await store.getVault(user.id) });
  }

  if (req.method === "POST" && url.pathname === "/me/command") {
    const body = await readBody(req);
    if (!body.text || typeof body.text !== "string") {
      return json(res, 400, { error: 'body must be {"text": "..."}' });
    }
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "your vault is still being provisioned, try again in a moment" });
    const { loadConvo, saveConvo } = await import("./convo.js");
    const decision = await processCommand(body.text, {
      chain: ctx,
      journal: (await import("./journal.js")).journalFor(user.id),
      convo: await loadConvo(user.id),
    });
    // balance questions deserve the FULL picture: vault caps/balances (from the
    // executor) + the user's own primary/savings wallets (product-layer context
    // the vault-scoped executor cannot see)
    if (decision.decision === "query") {
      try {
        const line = walletBalancesLine(await walletBalancesView(user.id));
        if (line) decision.explanation = `${decision.explanation} ${line}`;
      } catch { /* chain hiccup — answer without wallet line */ }
    }
    await recordDecision(user, decision);
    await saveConvo(user.id); // persist turns + pending so multi-turn chat survives cold starts
    return json(res, 200, decision);
  }

  // Guidance layer — answers questions about Aegis, the user's setup, or
  // crypto basics. Advisory ONLY: this route never parses intents, never
  // executes, never queues. LLM answer grounded in live facts; curated FAQ
  // fallback keeps it useful when the LLM is down.
  if (req.method === "POST" && url.pathname === "/me/help") {
    const body = await readBody(req);
    const text = String(body?.text ?? "").trim().slice(0, 400);
    if (!text) return json(res, 400, { error: 'body must be {"text": "…"}' });
    const history = sanitizeHelpHistory(body?.history);
    const result = await helpAnswer({ user, text, history });
    return json(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/me/approvals") {
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    return json(res, 200, { pending: await ctx.pendingQueue() });
  }

  const approval = url.pathname.match(/^\/me\/approvals\/(\d+)\/(approve|reject)$/);
  if (req.method === "POST" && approval) {
    const id = Number(approval[1]);
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    const result = approval[2] === "approve"
      ? await ownerActions.approveAndExecute(id, ctx)
      : await ownerActions.reject(id, ctx);
    const txHash = result.executeApprovedTx?.hash || result.rejectTx?.hash || result.approveTx?.hash || null;
    await recordOwnerOp(user, approval[2] === "approve" ? "approved & executed" : "rejected",
      `Queue item #${id} ${approval[2] === "approve" ? "approved and executed from your key" : "rejected, logged on-chain"}.`, txHash);
    return json(res, 200, { id, action: approval[2], result });
  }

  if (req.method === "GET" && url.pathname === "/me/rejections") {
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    return json(res, 200, { rejections: await ctx.rejections(Number(q.get("limit") || 20)) });
  }

  if (req.method === "GET" && url.pathname === "/me/quote") {
    const sell = (q.get("sell") || "USDC").toUpperCase();
    const buy = (q.get("buy") || "ETH").toUpperCase();
    const amount = Number(q.get("amount") || 0);
    if (!(amount > 0)) return json(res, 400, { error: "amount must be > 0" });
    return json(res, 200, await chain.quoteSwap(sell, buy, amount));
  }

  if (req.method === "GET" && url.pathname === "/me/payees") {
    return json(res, 200, { payees: await store.listPayees(user.id) });
  }

  if (req.method === "POST" && url.pathname === "/me/payees") {
    const body = await readBody(req);
    const label = String(body.label || "").trim().slice(0, 32);
    const category = String(body.category || "other").trim().slice(0, 24);
    if (!label) return json(res, 400, { error: "label is required" });
    let address;
    try { address = normAddr(body.address); } catch { return json(res, 400, { error: "address must be 0x…40 hex" }); }
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    let result;
    try {
      result = await ownerActions.whitelist(address, label, ctx);
    } catch (err) {
      return json(res, 400, { error: String(err?.message || err).slice(0, 200) });
    }
    await store.addPayee({ userId: user.id, label, address, category });
    await recordOwnerOp(user, "payee added", `Whitelisted "${label}" (${address}).`, result?.hash || null);
    return json(res, 200, { added: address, label, result });
  }

  if (req.method === "DELETE" && url.pathname === "/me/payees") {
    let address;
    try { address = normAddr(q.get("address")); } catch { return json(res, 400, { error: "address must be 0x…40 hex" }); }
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    const r = await ctx.send(ctx.vaultAsOwner, "setWhitelist", address, "Removed", false);
    await store.deletePayee(user.id, address);
    await recordOwnerOp(user, "payee removed", `Delisted ${address}.`, r?.hash || null);
    return json(res, 200, { removed: address, result: r });
  }

  if (req.method === "POST" && url.pathname === "/me/policy") {
    const body = await readBody(req);
    const symbol = String(body.symbol || "").toUpperCase();
    const meta = tokens[symbol];
    if (!meta) return json(res, 400, { error: "symbol must be USDC or ETH" });
    if (!(Number(body.maxPerTx) > 0) || !(Number(body.dailyLimit) > 0)) {
      return json(res, 400, { error: "maxPerTx and dailyLimit must be positive numbers" });
    }
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    const r = await ctx.send(
      ctx.vaultAsOwner, "setTokenPolicy",
      meta.address, toBaseUnits(Number(body.maxPerTx), meta.decimals), toBaseUnits(Number(body.dailyLimit), meta.decimals)
    );
    await recordOwnerOp(user, "limits updated",
      `${symbol}: max ${body.maxPerTx} per tx, ${body.dailyLimit} per rolling 24h.`, r?.hash || null);
    return json(res, 200, { symbol, result: r });
  }

  const agentCtl = url.pathname.match(/^\/me\/agent\/(pause|resume)$/);
  if (req.method === "POST" && agentCtl) {
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    const r = agentCtl[1] === "pause" ? await ownerActions.pause(ctx) : await ownerActions.resume(ctx);
    await recordOwnerOp(user, agentCtl[1] === "pause" ? "agent paused" : "agent resumed",
      agentCtl[1] === "pause" ? "Kill switch engaged; the agent can move nothing." : "Agent reactivated within your limits.", r?.hash || null);
    return json(res, 200, { action: agentCtl[1], result: r });
  }

  if (req.method === "POST" && url.pathname === "/me/withdraw") {
    const body = await readBody(req);
    const symbol = String(body.symbol || "USDC").toUpperCase();
    const meta = tokens[symbol];
    if (!meta) return json(res, 400, { error: "symbol must be USDC or ETH" });
    let to;
    try { to = normAddr(body.to); } catch { return json(res, 400, { error: "to must be 0x…40 hex" }); }
    if (!(Number(body.amount) > 0)) return json(res, 400, { error: "amount must be > 0" });
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    const r = await ctx.send(ctx.vaultAsOwner, "ownerWithdraw", meta.address, to, toBaseUnits(Number(body.amount), meta.decimals));
    await recordOwnerOp(user, "withdrawal", `Sovereign withdrawal of ${body.amount} ${symbol} to ${to}.`, r?.hash || null);
    return json(res, 200, { result: r });
  }

  if (req.method === "GET" && url.pathname === "/me/activity") {
    return json(res, 200, { activities: await store.listActivities(user.id, Math.min(Number(q.get("limit") || 50), 200)) });
  }

  if (req.method === "GET" && url.pathname === "/me/notifications") {
    return json(res, 200, { notifications: await store.listNotifications(user.id, 30) });
  }

  const noteRead = url.pathname.match(/^\/me\/notifications\/(\d+)\/read$/);
  if (req.method === "POST" && noteRead) {
    await store.markNotificationRead(user.id, noteRead[1]);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/me/export-key") {
    const body = await readBody(req);
    const kind = body.kind === "savings" ? "savings" : "primary";
    let wallet;
    try {
      wallet = await auth.exportWallet(user.id, kind, String(body.password || ""));
    } catch {
      return json(res, 401, { error: "wrong password" });
    }
    await store.addActivity({ userId: user.id, kind: "key-export", decision: "export", explanation: `${kind} key exported by the account owner (self-custody).` });
    return json(res, 200, { kind, ...wallet, note: "You are the only custodian. Aegis stores this only encrypted with your password." });
  }

  if (req.method === "POST" && url.pathname === "/me/faucet") {
    const last = faucetCooldown.get(user.id) || 0;
    const waitMs = config.faucetCooldownMin * 60 * 1000 - (Date.now() - last);
    if (waitMs > 0) return json(res, 429, { error: `faucet cooldown, try again in ${Math.ceil(waitMs / 60000)} min` });
    const ctx = await userChainContext(user.id);
    if (!ctx) return json(res, 409, { error: "vault not ready" });
    const vaultAddr = await ctx.vault.getAddress();
    const r = await chain.mintMockUsdcFrom(chain.agentWallet, vaultAddr, toBaseUnits(config.faucetAmountUsdc, 6));
    if (!r.ok) return json(res, 502, { error: `mint failed: ${r.revert}` });
    faucetCooldown.set(user.id, Date.now());
    await recordOwnerOp(user, "faucet", `Topped up ${config.faucetAmountUsdc.toLocaleString()} tUSDC from the demo faucet.`, r.hash);
    return json(res, 200, { ok: true, amount: config.faucetAmountUsdc, txHash: r.hash });
  }

  json(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
}

/* ═══════════════════════════════════════════════════════════════════════════
   JUDGE MODE routes (unchanged CP2/CP3 surface) + shared /health
   ═══════════════════════════════════════════════════════════════════════════ */

async function route(req, res, url) {
  const q = url.searchParams;

  if (req.method === "GET" && url.pathname === "/health") {
    const body = {
      ok: true,
      service: "aegis-agent",
      version: AGENT_VERSION,
      checkpoint: "CP2",
      mode: config.productMode ? "product" : "judge",
      chain: config.rpcUrl,
      vault: config.vault || null,
      venue: config.venue,
      usdc: config.usdc,
      dryRun: config.dryRun,
      llmProvider: config.llmProvider,
      llmProviderResolved: config.llmProviderResolved, // after auto-detect — what actually parses intents
      llmModel: config.llmModelSet ? config.llmModel : null,
      // live LLM health: circuit breaker state, last error (with the REAL
      // network cause), proxy config — answers "why is the chat so fast/slow?"
      llm: llmStatus(),
      // does the RESOLVED provider actually have its key? (rules needs none)
      llmKey:
        config.llmProviderResolved === "openai"
          ? config.openaiKey
            ? "OPENAI_API_KEY set — LLM parsing armed"
            : "OPENAI_API_KEY MISSING — set it in agent/.env (commands still work via rules fallback)"
          : config.llmProviderResolved === "huggingface" || config.llmProviderResolved === "hf"
            ? config.hfToken
              ? "HF_TOKEN set — LLM parsing armed"
              : "HF_TOKEN MISSING — set it in agent/.env (commands still work via rules fallback)"
            : config.llmProviderResolved === "rules"
              ? "rules parser (offline mode — set OPENAI_API_KEY or LLM_PROVIDER=openai for LLM parsing)"
              : "not needed",
      hf: config.hfToken
        ? "token set — huggingface LLM + FinBERT/MiniLM advisory armed"
        : "no token — rules parser + 4 deterministic risk families",
      sentiment: config.hfToken ? "finbert+minilm (HF)" : "off (no HF_TOKEN)",
      // resolved tuning + any .env parse problems — a misconfigured threshold
      // is visible here instead of silently disabling a risk family
      tuning: {
        autoRiskThreshold: config.autoRiskThreshold,
        rejectRiskThreshold: config.rejectRiskThreshold,
        amountAnomalyX: config.amountAnomalyX,
        velocityWindowEntries: config.velocityWindowEntries,
        slippageBps: config.slippageBps,
      },
      envWarnings: configWarnings,
    };
    if (config.productMode) {
      const info = await chain.chainInfo();
      const stats = await getStore().stats().catch(() => ({ users: 0, vaultsDone: 0, sessions: 0 }));
      body.checkpoint = "CP4-product";
      body.chainInfo = info;
      body.store = getStore().kind;
      body.stats = stats;
      body.agent = chain.agentWallet ? await chain.agentWallet.getAddress().catch(() => null) : null;
      // operator fuel gauge: the provisioning pot that pays every user's
      // stipend + vault gas. Visible here so "why do signups fail" is a
      // one-curl diagnosis (dry pot = faucet the agent key).
      if (chain.agentWallet) {
        body.agentFuelEth = await chain.agentWallet
          .getAddress()
          .then((a) => chain.provider.getBalance(a))
          .then((b) => ethers.formatEther(b))
          .catch(() => null);
      }
    }
    // live swap-venue ETH inventory: the counterparty pays buy-side payouts
    // from its own balance, so a dry venue is the one-curl answer to
    // "why is every swap rejected?" (auto-refilled by ensureVenueLiquidity)
    if (config.venue) {
      body.venueEth = await chain.provider
        .getBalance(config.venue)
        .then((b) => ethers.formatEther(b))
        .catch(() => null);
    }
    // swap price reference (v3.9.5): what the Chainlink ETH/USD feed says
    // right now, so every venue rate can be compared against it at a glance.
    // Best-effort: no feed on this chain = { skipped }, never a failed /health.
    body.oracle = await chain
      .oracleStatus()
      .catch(() => ({ error: "oracle status unavailable" }));
    return json(res, 200, body);
  }

  // ── product mode: everything else lives under /auth + /me ────────────────
  if (config.productMode) return routeProduct(req, res, url);

  if (req.method === "GET" && url.pathname === "/state") {
    const snap = await chain.snapshot();
    return json(res, 200, {
      ...summarizeState(snap),
      tokens: snap.tokens, // full detail incl. balances, liveEntries
    });
  }

  if (req.method === "POST" && url.pathname === "/command") {
    const body = await readBody(req);
    if (!body.text || typeof body.text !== "string") {
      return json(res, 400, { error: "body must be {\"text\": \"...\"}" });
    }
    const decision = await processCommand(body.text);
    return json(res, 200, decision);
  }

  if (req.method === "GET" && url.pathname === "/history") {
    return json(res, 200, { decisions: decisions(Number(q.get("limit") || 20)) });
  }

  if (req.method === "GET" && url.pathname === "/approvals") {
    return json(res, 200, { pending: await chain.pendingQueue() });
  }

  const approval = url.pathname.match(/^\/approvals\/(\d+)\/(approve|reject)$/);
  if (req.method === "POST" && approval) {
    const id = Number(approval[1]);
    const result = approval[2] === "approve"
      ? await ownerActions.approveAndExecute(id)
      : await ownerActions.reject(id);
    return json(res, 200, { id, action: approval[2], result });
  }

  if (req.method === "GET" && url.pathname === "/rejections") {
    return json(res, 200, { rejections: await chain.rejections(Number(q.get("limit") || 20)) });
  }

  if (req.method === "GET" && url.pathname === "/quote") {
    const sell = (q.get("sell") || "USDC").toUpperCase();
    const buy = (q.get("buy") || "ETH").toUpperCase();
    const amount = Number(q.get("amount") || 0);
    if (!(amount > 0)) return json(res, 400, { error: "amount must be > 0" });
    return json(res, 200, await chain.quoteSwap(sell, buy, amount));
  }

  if (req.method === "POST" && (url.pathname === "/owner/pause" || url.pathname === "/owner/resume")) {
    const r = url.pathname.endsWith("pause") ? await ownerActions.pause() : await ownerActions.resume();
    return json(res, 200, { action: url.pathname.slice(1), result: r });
  }

  if (req.method === "POST" && url.pathname === "/whitelist") {
    const body = await readBody(req);
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || "")) {
      return json(res, 400, { error: "address must be 0x…40 hex" });
    }
    const r = await ownerActions.whitelist(body.address, body.label || "Unlabeled");
    return json(res, 200, { added: body.address, label: body.label, result: r });
  }

  if (req.method === "GET" && url.pathname === "/faucet/status") {
    return json(res, 200, faucetStatus());
  }

  if (req.method === "POST" && url.pathname === "/faucet/claim") {
    const body = await readBody(req);
    const r = await faucetClaim(body.address || "");
    return json(res, r.ok ? 200 : 429, r);
  }

  json(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
}

/** The shared request handler — used verbatim by the long-running server
 *  AND by the Vercel function wrapper (api/index.js). Vercel rewrites keep
 *  req.url at the original client path, so routing is identical on both. */
export async function handleAegisRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    return res.end();
  }
  try {
    await route(req, res, url);
  } catch (err) {
    console.error(`[500] ${req.method} ${url.pathname}:`, String(err?.message || err).slice(0, 300));
    json(res, 500, { error: String(err?.message || err).slice(0, 300) });
  }
}

/** Idempotent cold-start boot for serverless (Vercel). Safe to call on every
 *  request — only the first call does the work; concurrent callers await the
 *  same promise. Skips keepalive/event-polling (no long-lived loop there). */
let _bootPromise = null;
export function bootForServerless() {
  if (!_bootPromise) _bootPromise = _bootForServerlessInner();
  return _bootPromise;
}

async function _bootForServerlessInner() {
  if (config.productMode) await initStore(); // store must exist before traffic
  console.log(`Aegis agent ${AGENT_VERSION} — serverless boot (${config.productMode ? "product" : "judge"} mode)`);
  if (config.productMode) {
    const info = await chain.chainInfo().catch(() => null);
    if (info) console.log(`  chain   : ${info.name} (id ${info.chainId})  explorer: ${info.explorer || "none"}`);
    console.log(`  store   : ${getStore().kind === "pg" ? "postgres" : "IN-MEMORY (DATABASE_URL not set!)"}`);
    console.log(
      `  intent  : ${config.llmProviderResolved}` +
      `${config.llmProviderResolved !== "rules" ? `  model: ${config.llmModel}` : "  (deterministic parser)"}`
    );
    // resume/self-heal must never block the first request; on Vercel they are
    // handed to waitUntil so the invocation stays alive until they finish
    bg(resumePending().then((n) => { if (n) console.log(`  resumed : ${n} pending provision(s)`); return n; }));
    bg(healStaleVaults().catch((e) => {
      console.warn(`  [self-heal] sweep skipped: ${String(e?.message || e).slice(0, 120)}`);
      return 0;
    }).then((n) => { if (n > 0) console.log(`  self-heal: ${n} vault(s) re-provisioning`); return n; }));
    // standing venue-inventory check: refill the swap counterparty when it
    // ran dry (one read; a top-up only fires below VENUE_ETH_MIN)
    bg(chain.ensureVenueLiquidity().then((r) => {
      if (r && r.ok === false) console.warn(`  [venue] ${r.reason || "inventory check failed"}`);
      return r;
    }).catch(() => {}));
    llmPreflight().catch(() => {});
  }
  if (configWarnings.length) {
    for (const w of configWarnings) console.log(`  [warn] ${w}`);
  }
  return true;
}

export async function startServer() {
  if (config.productMode) await initStore(); // store must exist before traffic

  const server = createServer(handleAegisRequest);

  server.listen(config.port, config.host, async () => {
    console.log(`Aegis agent ${AGENT_VERSION} listening on http://${config.host}:${config.port}`);
    if (config.productMode) {
      const info = await chain.chainInfo();
      console.log(`  mode    : PRODUCT (accounts + per-user vaults)`);
      console.log(`  chain   : ${info.name} (id ${info.chainId})  explorer: ${info.explorer || "none"}`);
      console.log(`  agent   : ${chain.agentWallet ? await chain.agentWallet.getAddress() : "(no key!)"}`);
      console.log(`  usdc    : ${config.usdc || "(missing!)"}   venue: ${config.venue || "(missing!)"}`);
      console.log(`  store   : ${getStore().kind === "pg" ? "postgres" : "in-memory (DATABASE_URL not set!)"}`);
      console.log(
        `  intent  : ${config.llmProviderResolved}${config.llmProviderAuto && config.llmProviderResolved !== "rules" ? " (auto-detected from key)" : ""}` +
        `${config.llmProviderResolved !== "rules" ? `  model: ${config.llmModel}` : "  (deterministic parser — add OPENAI_API_KEY for LLM parsing)"}`
      );
      const resumed = await resumePending().catch(() => 0);
      if (resumed) console.log(`  resumed : ${resumed} pending provision(s)`);
      // chain-reset sweep: Postgres outlives anvil — re-provision code-less vaults
      const healed = await healStaleVaults().catch((e) => {
        console.warn(`  [self-heal] sweep skipped: ${String(e?.message || e).slice(0, 120)}`);
        return 0;
      });
      if (healed > 0) console.log(`  self-heal: ${healed} vault(s) lost their code (chain reset) — re-provisioning`);
      const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${config.port}`;
      if (!process.env.VERCEL) startKeepalive(selfUrl);
    } else {
      console.log(`  vault   : ${config.vault}`);
      console.log(`  venue   : ${config.venue}`);
      console.log(`  provider: ${config.llmProvider}   dry-run: ${config.dryRun}`);
      console.log(
        `  tuning  : auto-risk>=${config.autoRiskThreshold}  reject-risk>=${config.rejectRiskThreshold}` +
        `  anomaly-x=${config.amountAnomalyX}  velocity>=${config.velocityWindowEntries}  slippage=${config.slippageBps}bps`
      );
    }
    // venue inventory self-heal: refill the shared swap counterparty when it
    // runs dry (one read; a top-up only fires below VENUE_ETH_MIN)
    const venueLiq = await chain.ensureVenueLiquidity().catch(() => ({ ok: false, reason: "inventory check failed" }));
    if (venueLiq.ok === false) {
      console.warn(`  [venue] ${venueLiq.reason || "inventory check failed"}; swaps will be rejected until it is funded`);
    }
    if (configWarnings.length) {
      console.log(`  [warn] .env problems (defaults substituted):`);
      for (const w of configWarnings) console.log(`    - ${w}`);
    } else {
      console.log(`  env     : all values parsed cleanly`);
    }
    // LLM preflight (async, non-blocking): one cheap authenticated GET so a
    // dead DNS record / invisible Windows proxy / bad key is visible at BOOT,
    // and the circuit breaker is pre-armed for instant rules-only answers.
    llmPreflight().catch(() => {});
    console.log(`  try: curl -s http://127.0.0.1:${config.port}/health`);
    if (config.eventPoll && config.vault) chain.startEventPoller();
  });
  return server;
}

// entry point — canonical main-module check. (The naive `file://${argv[1]}`
// string compare silently skipped startup when the repo lived under a path
// containing spaces — e.g. "aegis-wallet-checkpoint3 (2)" — because
// import.meta.url percent-encodes them as %20 while argv[1] does not: the
// agent then exited 0 with no output at all. pathToFileURL normalizes both.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = [];
  if (config.productMode) {
    if (!config.usdc) missing.push("USDC_ADDRESS");
    if (!config.venue) missing.push("VENUE_ADDRESS");
    if (!config.agentKey) missing.push("AGENT_KEY");
    if (!config.serverSecret) missing.push("AEGIS_SERVER_SECRET");
  } else {
    if (!config.vault) missing.push("VAULT_ADDRESS");
  }
  if (missing.length) {
    console.error(`AEGIS_MODE=${config.aegisMode} requires ${missing.join(", ")} — copy .env.example to .env and fill them in.`);
    process.exit(1);
  }
  startServer();
}
