// LLM intent extraction with a strict JSON schema (plan component #1).
// Provider chain (LLM_PROVIDER):
//   rules        — deterministic parser only (offline, no keys)
//   openai       — any OpenAI-compatible endpoint (OpenAI / DeepSeek / Groq / Ollama)
//   huggingface  — HF Inference Providers router (free hf.co access token;
//                  HF_BASE_URL, default https://router.huggingface.co/v1)
//   zai          — z-ai-web-dev-sdk (development sandbox)
//   all          — every configured LLM in order (openai -> huggingface -> zai),
//                  deterministic fallback on ANY failure/invalid schema
// The LLM NEVER gets the final word: its output is schema-validated and its
// recipient labels are cross-checked against the live on-chain whitelist.

import { parseIntentRules, validateIntent } from "./intent.js";
import { config } from "./config.js";

// Served through the HF router by several providers; a solid default for the
// strict-JSON intent task. Override with LLM_MODEL=<any model id your account
// can call>.
const HF_DEFAULT_MODEL = "meta-llama/Llama-3.1-8B-Instruct";

// ── proxy-aware fetch ──────────────────────────────────────────────────────
// Node's built-in fetch (undici) IGNORES the HTTP_PROXY/HTTPS_PROXY env vars
// (honoring them only arrives with NODE_USE_ENV_PROXY in Node 24). On WSL or
// VPN setups where the internet is only reachable through a Windows-side
// proxy, every direct LLM call dies with a bare "fetch failed". When the
// operator sets HTTPS_PROXY in agent/.env we route LLM traffic through
// undici's ProxyAgent instead (requires `npm i undici` in agent/).
let dispatcherPromise = null;
async function proxyDispatcher() {
  if (!config.httpsProxy) return undefined;
  if (!dispatcherPromise) {
    dispatcherPromise = (async () => {
      try {
        const { ProxyAgent } = await import("undici");
        return new ProxyAgent(config.httpsProxy);
      } catch {
        console.warn(
          `[intent] HTTPS_PROXY=${config.httpsProxy} is set but the 'undici' package is missing —\n` +
            `  proxy routing DISABLED, calls go direct. Fix: cd agent && npm i undici`
        );
        return null;
      }
    })();
  }
  return dispatcherPromise;
}

/** fetch that transparently honors the configured proxy, if any. */
export async function llmFetch(url, opts = {}) {
  const dispatcher = await proxyDispatcher();
  return fetch(url, dispatcher ? { ...opts, dispatcher } : opts);
}

// ── circuit breaker ─────────────────────────────────────────────────────────
// A dead endpoint must not tax EVERY user message with a full connect timeout
// (10–15s of silence before the rules fallback fires). After 2 consecutive
// failures the breaker OPENS: intents parse instantly via rules until the
// cooldown (LLM_COOLDOWN_MS, default 60s) elapses, then the next message
// retries the LLM (half-open). Any success closes it again.
const breaker = { fails: 0, openUntil: 0, lastError: "" };
const BREAKER_AFTER = 2;

/** Live LLM health — surfaced in /health so ops can see why messages are fast
 *  (rules) instead of slow (LLM). */
export function llmStatus() {
  const open = Date.now() < breaker.openUntil;
  return {
    provider: config.llmProviderResolved,
    model: config.llmProviderResolved === "rules" ? null : config.llmModel,
    breaker: open ? "open (instant rules-only, auto-retry soon)" : "closed",
    retryInMs: open ? breaker.openUntil - Date.now() : 0,
    consecutiveFailures: breaker.fails,
    lastError: breaker.lastError || null,
    proxy: config.httpsProxy || null,
  };
}

function breakerTrip(err, { force = false } = {}) {
  breaker.fails += 1;
  breaker.lastError = describeError(err);
  const shouldOpen = breaker.fails >= BREAKER_AFTER || force;
  if (shouldOpen && Date.now() >= breaker.openUntil) {
    breaker.openUntil = Date.now() + config.llmCooldownMs;
    console.warn(
      `[intent] LLM failed ${breaker.fails}x — breaker OPEN: instant rules-only parsing for ${Math.round(config.llmCooldownMs / 1000)}s, then I auto-retry the LLM. (${breaker.lastError})`
    );
  }
}

function breakerOk() {
  if (breaker.fails > 0 || breaker.openUntil > 0)
    console.log(`[intent] LLM recovered — breaker closed, LLM parsing active again`);
  breaker.fails = 0;
  breaker.openUntil = 0;
  breaker.lastError = "";
}

// "fetch failed" alone says nothing actionable — undici hides the real cause
// in err.cause (DNS? TCP timeout? TLS?). Unwrap it so the terminal shows the
// actual network error, not a shrug.
function describeError(err) {
  if (err?.name === "AbortError")
    return `timeout after ${config.llmTimeoutMs}ms (no response)`;
  const cause = err?.cause
    ? ` — cause: ${err.cause.code || err.cause.message || String(err.cause)}`
    : "";
  return `${String(err?.message || err).slice(0, 160)}${cause}`;
}

/** The single most likely fix for each failure class — printed right under
 *  the error so WSL/proxy issues are debuggable without reading source. */
function hintFor(err) {
  const text = `${err?.message || ""} ${err?.cause?.code || ""} ${err?.cause?.message || ""} ${err?.cause || ""}`;
  if (/ENOTFOUND|EAI_AGAIN/.test(text))
    return "DNS cannot resolve the endpoint. WSL: check /etc/resolv.conf (try nameserver 8.8.8.8), or set OPENAI_BASE_URL to a relay you can reach";
  if (/ETIMEDOUT|CONNECT_TIMEOUT|ECONNREFUSED|EHOSTUNREACH|fetch failed/i.test(text))
    return `cannot connect. If your internet needs a Windows-side VPN/proxy, add HTTPS_PROXY=http://<windows-host>:<port> to agent/.env and run: npm i undici`;
  if (/HTTP 401|HTTP 403/.test(text))
    return "key rejected — check OPENAI_API_KEY (and OPENAI_BASE_URL if you use a relay)";
  if (/HTTP 404/.test(text))
    return "model not found — check LLM_MODEL against your provider's model ids";
  if (/HTTP 429/.test(text))
    return "rate limited or out of credits — check your OpenAI billing dashboard";
  if (err?.name === "AbortError")
    return "endpoint too slow — raise LLM_TIMEOUT_MS, or pick a faster LLM_MODEL";
  return "";
}

function resolveHfModel() {
  // An unset LLM_MODEL falls back to config's generic default ("gpt-4o-mini").
  // For the HF provider that would 404, so resolve to the HF default instead.
  return config.llmModel && config.llmModel !== "gpt-4o-mini" ? config.llmModel : HF_DEFAULT_MODEL;
}

// Reasoning-family models (gpt-5*, o1/o3/o4-series) only support the DEFAULT
// temperature (1) — sending temperature: 0 makes them return HTTP 400
// ("Unsupported value: 'temperature' does not support 0 with this model.").
// The agent omits the parameter for them; every other model keeps
// temperature 0 for deterministic parses. Matched loosely on purpose so
// routed ids like "openai/gpt-5-nano" are caught too.
function isReasoningModel(model) {
  return /(^|\/)(gpt-5|o[134])/i.test(String(model || ""));
}

// Shared chat-completions payload: temperature 0 (deterministic) unless the
// model is a reasoning family that forbids overriding it. For those the
// request also pins reasoning_effort "low" — intent parsing is extraction,
// not deep thought, and medium effort made gpt-5-nano take ~10s per command.
export function llmPayload(model, messages, { reasoningEffort = false } = {}) {
  const payload = { model, temperature: 0, messages };
  if (isReasoningModel(model)) {
    delete payload.temperature;
    if (reasoningEffort) payload.reasoning_effort = "low";
  }
  return payload;
}

const SYSTEM_PROMPT = (whitelist, tokens) =>
  `You are the intent parser of Aegis Wallet, an AI financial agent with strict on-chain guardrails.
Extract the user's intent into JSON with EXACTLY this schema:
{
  "action": "transfer" | "swap" | "query" | "clarify" | "revert",
  "token": "USDC" | "ETH",            // asset to send/sell
  "buyToken": "USDC" | "ETH",         // swap only
  "recipient": {"type": "label", "value": "<one of the whitelist labels>"} | {"type": "address", "value": "0x..."} | null,
  "amount": <positive number in human units> | "all" | null,   // "all" = the user's entire balance of that token
  "clarify": "<one short question in the user's language>",   // clarify only, else omit
  "rationale": "<one-sentence justification>",
  "confidence": <0..1>
}
Rules:
- The ONLY valid recipients are the whitelist labels below, or an explicit 0x address written by the user.
- MULTI-TURN CHAT: earlier turns are included as message history. The user's new message often ANSWERS your previous question with partial information (just a token, an amount, "all", or an address, possibly in a different language). Combine the history with the new message and fill every field you can; ask again ONLY for what is still missing after combining.
- A string starting with 0x that is NOT exactly 40 hex characters (0-9, a-f) is a MALFORMED address: use action "clarify" and tell the user the address must be 0x followed by exactly 40 hex characters. Never round it up, never guess missing characters.
- "revert" means the user wants to undo or cancel recent actions (revert / undo / ফেরত / wapas / 取り消し). Use action "revert"; the agent cancels pending approvals and explains what cannot be undone.
- Language: the user may write in ANY language and script — native or romanized (Hinglish, Banglish, Taglish, Arabizi, pinyin…), or MIXING several languages in one sentence. Parse the underlying intent; never ask the user to switch languages.
- Match recipients to the whitelist SEMANTICALLY across languages: madre/mãe/माँ/মা/妈妈/أمي/ammi/maman → "Mom"; casero/房东/বাড়িওয়ালা → the rent/landlord label. If the referent is not clearly ONE label, use "clarify".
- A "from X" phrase in ANY language (from / theke / se / से / থেকে / de / desde / 从 / から / من) names the SOURCE of funds, never the recipient. Funds always leave the user's vault. Example: "tui amr savings theke landlord ke 50 dollar patha" = transfer 50 USDC to Landlord (theke = from, ke = to).
- Money in ANY fiat word (dollars/taka/rupees/yuan/yen/euro/pesos/美元/टाका/৳…) means USDC. Amounts are plain numbers (800, not "800 USDC"). Full-balance words (all / everything / sob / sab / सब / সব / todo) mean amount "all".
- If the command is ambiguous, incomplete, or you would have to guess ANY field, use action "clarify" and add "clarify": "<one short question phrased in the language(s) the user used>".
- If the user is only greeting you or making small talk (hi / kire ki khobor / kemon acho / hola / 你好 / مرحبا …) with NO financial request, use action "clarify" with a short warm reply in their own language: greet them back, then ONE line saying what you can do — pay their payees, move money to savings, swap USDC and ETH, report balances — and that any language works.
- Deposits count as transfers: "put/load/deposit/top up X into savings" or "savings e X ano/daalo/rakho" means transfer X to the savings label.
- NEVER invent addresses, labels, or amounts. You are a parser, not an actor.
- STYLE for any text you write (clarify questions): short plain sentences in the user's language. No em-dashes.
Whitelist labels: ${whitelist.map((w) => `"${w.label}"`).join(", ") || "(empty)"}
Tokens: ${tokens.join(", ")}`;

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in LLM reply");
  return JSON.parse(raw.slice(start, end + 1));
}

async function callOpenAICompatible(text, whitelist, tokens, history = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const res = await llmFetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.openaiKey}`,
      },
      body: JSON.stringify({
        ...llmPayload(config.llmModel, [
          { role: "system", content: SYSTEM_PROMPT(whitelist, tokens) },
          ...history,
          { role: "user", content: text },
        ], { reasoningEffort: true }),
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return extractJson(data.choices?.[0]?.message?.content || "");
  } finally {
    clearTimeout(timer);
  }
}

// Hugging Face Inference Providers — the OpenAI-compatible router at
// https://router.huggingface.co/v1/chat/completions. Works with a free
// hf.co access token (monthly inference credits). No `response_format` is
// sent: provider support for it varies, and extractJson() already strips
// fences/prose around the JSON object.
async function callHuggingFace(text, whitelist, tokens, history = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const res = await llmFetch(`${config.hfBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.hfToken}`,
      },
      body: JSON.stringify({
        ...llmPayload(resolveHfModel(), [
          { role: "system", content: SYSTEM_PROMPT(whitelist, tokens) },
          ...history,
          { role: "user", content: text },
        ]),
        max_tokens: 400,
      }),
    });
    if (!res.ok) throw new Error(`HF HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return extractJson(data.choices?.[0]?.message?.content || "");
  } finally {
    clearTimeout(timer);
  }
}

async function callZai(text, whitelist, tokens, history = []) {
  const mod = await import("z-ai-web-dev-sdk"); // dev-sandbox provider
  const ZAI = mod.default;
  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: [
      { role: "assistant", content: SYSTEM_PROMPT(whitelist, tokens) },
      ...history,
      { role: "user", content: text },
    ],
    thinking: { type: "disabled" },
  });
  return extractJson(completion.choices?.[0]?.message?.content || "");
}

async function tryLLM(text, whitelist, tokens, history = []) {
  const provider = config.llmProviderResolved;
  if (provider === "openai") {
    if (!config.openaiKey) throw new Error("OPENAI_API_KEY not set");
    return await callOpenAICompatible(text, whitelist, tokens, history);
  }
  if (provider === "huggingface" || provider === "hf") {
    if (!config.hfToken) throw new Error("HF_TOKEN not set");
    return await callHuggingFace(text, whitelist, tokens, history);
  }
  if (provider === "zai") return await callZai(text, whitelist, tokens, history);
  if (provider === "all") {
    if (config.openaiKey) {
      try { return await callOpenAICompatible(text, whitelist, tokens, history); }
      catch { /* fall through to huggingface, then zai, then rules */ }
    }
    if (config.hfToken) {
      try { return await callHuggingFace(text, whitelist, tokens, history); }
      catch { /* fall through to zai, then rules */ }
    }
    return await callZai(text, whitelist, tokens, history);
  }
  throw new Error(`LLM provider '${provider}' not configured`);
}

/** The provider that actually parses intents right now (auto-detect aware).
 *  auto -> openai when OPENAI_API_KEY is set, huggingface when HF_TOKEN is,
 *  rules otherwise. Explicit LLM_PROVIDER values bypass detection. */
export function effectiveLlmProvider() {
  return config.llmProviderResolved;
}

/**
 * Parse intent with the configured provider chain. LLM first whenever a key
 * is present (auto-detect), deterministic rules as the always-there fallback
 * — a dead key or a timeout can never stop the agent from answering.
 * @returns {Promise<{intent: object, meta: {provider: string, llmUsed: boolean, fallback?: string}}>}
 */
export async function parseIntent(text, whitelist, tokens, history = []) {
  const provider = config.llmProviderResolved;
  if (provider !== "rules") {
    // breaker OPEN: skip the doomed call entirely — the user gets an instant
    // rules answer instead of 10–15s of timeout silence on every message
    if (Date.now() < breaker.openUntil) {
      const fb = parseIntentRules(text, whitelist, { USDC: { available: true } });
      return {
        intent: fb,
        meta: {
          provider: "rules(cooldown)",
          llmUsed: false,
          fallback: `LLM breaker open — auto-retry in ${Math.ceil((breaker.openUntil - Date.now()) / 1000)}s (${breaker.lastError})`.slice(0, 160),
        },
      };
    }
    try {
      const candidate = await tryLLM(text, whitelist, tokens, history);
      breakerOk();
      candidate.rationale = (candidate.rationale || text).slice(0, 180);
      candidate.parser = "llm";
      const v = validateIntent(candidate, whitelist, tokens);
      if (v.valid) return { intent: candidate, meta: { provider, llmUsed: true } };
      // schema failure => deterministic fallback (never hallucinate parameters)
      const why = `LLM output rejected by schema: ${v.problems.join("; ")}`;
      console.warn(`[intent] ${why} — rules fallback for "${text.slice(0, 60)}"`);
      const fb = parseIntentRules(text, whitelist, { USDC: { available: true } });
      return { intent: fb, meta: { provider: "rules(fallback)", llmUsed: false, fallback: why } };
    } catch (err) {
      // Loud on purpose: a bad key / wrong model / unreachable endpoint shows
      // the REAL cause (undici hides it in err.cause) plus the likely fix the
      // moment it happens, instead of a bare "fetch failed" shrug.
      breakerTrip(err);
      const why = describeError(err).slice(0, 200);
      const hint = hintFor(err);
      console.warn(
        `[intent] LLM (${provider}) unavailable — rules fallback: ${why}` +
          (hint ? `\n         hint: ${hint}` : "")
      );
      const fb = parseIntentRules(text, whitelist, { USDC: { available: true } });
      return {
        intent: fb,
        meta: { provider: "rules(fallback)", llmUsed: false, fallback: `${why}${hint ? ` — ${hint}` : ""}`.slice(0, 160) },
      };
    }
  }
  return {
    intent: parseIntentRules(text, whitelist, { USDC: { available: true } }),
    meta: { provider: "rules", llmUsed: false },
  };
}

/** Startup preflight: one cheap authenticated GET against the resolved
 *  provider, run right after the banner prints. A broken DNS record, a
 *  Windows-side VPN the WSL agent can't see, or a dead key is visible at
 *  BOOT — not discovered 10 seconds into the first user message. A network
 *  failure also pre-arms the breaker so even message #1 parses instantly. */
export async function llmPreflight() {
  const provider = config.llmProviderResolved;
  if (provider === "rules" || provider === "zai") return { skipped: true };
  const useOpenai = provider === "openai" || (provider === "all" && config.openaiKey);
  const base = useOpenai ? config.openaiBaseUrl : config.hfBaseUrl;
  const key = useOpenai ? config.openaiKey : config.hfToken;
  if (!key) {
    console.warn(`[intent] LLM preflight skipped — ${useOpenai ? "OPENAI_API_KEY" : "HF_TOKEN"} not set (rules parser active)`);
    return { skipped: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const t0 = Date.now();
  try {
    const res = await llmFetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    breakerOk();
    console.log(`[intent] LLM preflight OK — ${provider} (${useOpenai ? config.llmModel : resolveHfModel()}) reachable in ${Date.now() - t0}ms`);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    // force-open: if boot can't reach the endpoint, message #1 should not pay
    // the timeout either. After the cooldown the next message retries the LLM.
    breakerTrip(err, { force: true });
    const hint = hintFor(err);
    console.warn(
      `[intent] LLM preflight FAILED — ${describeError(err)}` +
        (hint ? `\n         hint: ${hint}` : "") +
        `\n         (commands keep working — rules parser answers instantly; LLM auto-retries in ${Math.round(config.llmCooldownMs / 1000)}s)`
    );
    return { ok: false, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}
