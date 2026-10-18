// Accounts & embedded wallets for product mode.
//
// Model (disclosed openly — this is a testnet demo of a consumer product):
//   - email + password accounts, bcrypt hashes (never the raw password).
//   - every account gets TWO fresh Ethereum keys generated server-side:
//       primary → becomes the OWNER of the user's AegisVault
//       savings → a whitelisted "Savings" payee (a pot the agent can fill)
//   - keys are stored ONLY as keystore-v3 JSON, encrypted two ways:
//       a) with the USER's password  → "export my key" self-custody path
//       b) with AEGIS_SERVER_SECRET  → lets the relayer sign owner ops
//          (approve, pause, limits, withdraw) during a session without
//          re-asking for the password — exactly how embedded-wallet
//          providers work, minus the HSM (disclosed).
//   - decrypted keys live in process memory only, cached per user, wiped on
//     restart. Sessions are opaque random bearer tokens, not cookies, so the
//     API and dashboard can live on different domains.

import bcrypt from "bcryptjs";
import { ethers } from "ethers";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { getStore } from "./store.js";

// ── passwords ────────────────────────────────────────────────────────────────
export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

// ── embedded wallets ─────────────────────────────────────────────────────────
// Keystores are JSON strings at write time, but a JSONB column (Postgres)
// hands them back as parsed objects — normalize before ethers sees them.
const normalizeKeystore = (k) => (typeof k === "string" ? k : JSON.stringify(k));

export async function createEmbeddedWallets(password) {
  const primary = ethers.Wallet.createRandom();
  const savings = ethers.Wallet.createRandom();
  const [pkUser, pkServer, skUser, skServer] = await Promise.all([
    primary.encrypt(password),
    primary.encrypt(config.serverSecret),
    savings.encrypt(password),
    savings.encrypt(config.serverSecret),
  ]);
  return {
    primaryAddress: primary.address,
    savingsAddress: savings.address,
    primaryKeystoreUser: pkUser,
    primaryKeystoreServer: pkServer,
    savingsKeystoreUser: skUser,
    savingsKeystoreServer: skServer,
  };
}

/** Decrypt a server envelope into a connected signing wallet (cached per user). */
const signerCache = new Map(); // `${userId}:${kind}` -> ethers.NonceManager

export async function getSigner(userId, kind = "primary", provider) {
  const key = `${userId}:${kind}`;
  if (signerCache.has(key)) return signerCache.get(key);
  const ks = await getStore().getKeystores(userId);
  if (!ks) throw new Error("no keystores for user");
  const envelope = normalizeKeystore(
    kind === "savings" ? ks.savingsKeystoreServer : ks.primaryKeystoreServer
  );
  const w = await ethers.Wallet.fromEncryptedJson(envelope, config.serverSecret); // scrypt — 1-2s
  const wallet = new ethers.Wallet(w.privateKey, provider);
  const nm = new ethers.NonceManager(wallet);
  signerCache.set(key, nm);
  return nm;
}

/** Decrypt the USER envelope with the account password (export path). */
export async function exportWallet(userId, kind, password) {
  const ks = await getStore().getKeystores(userId);
  if (!ks) throw new Error("no keystores for user");
  const envelope = normalizeKeystore(
    kind === "savings" ? ks.savingsKeystoreUser : ks.primaryKeystoreUser
  );
  const w = await ethers.Wallet.fromEncryptedJson(envelope, password); // wrong password => throw
  return { address: w.address, privateKey: w.privateKey };
}

export function wipeSigners(userId) {
  for (const k of [...signerCache.keys()]) if (k.startsWith(`${userId}:`)) signerCache.delete(k);
}

// ── sessions ─────────────────────────────────────────────────────────────────
export async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  await getStore().createSession({ token, userId, expiresAt });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** Resolve a bearer token -> {user, session} | null. */
export async function sessionUser(token) {
  if (!token) return null;
  const s = await getStore().getSession(token);
  if (!s) return null;
  const user = await getStore().getUserById(s.userId);
  if (!user) return null;
  return { user, session: s };
}

export async function logout(token) {
  const s = token ? await getStore().getSession(token) : null;
  if (s) wipeSigners(s.userId);
  if (token) await getStore().deleteSession(token);
}

// ── login throttling (in-memory, per email) ─────────────────────────────────
const fails = new Map(); // email -> { count, until }
const MAX_FAILS = 5, FAIL_WINDOW_MS = 15 * 60 * 1000;

export function throttleCheck(email) {
  const f = fails.get(email);
  if (!f) return true;
  if (Date.now() > f.until) { fails.delete(email); return true; }
  return f.count < MAX_FAILS;
}
export function throttleFail(email) {
  const f = fails.get(email) || { count: 0, until: Date.now() + FAIL_WINDOW_MS };
  f.count += 1;
  f.until = Date.now() + FAIL_WINDOW_MS;
  fails.set(email, f);
}
export function throttleReset(email) { fails.delete(email); }

// ── HTTP helper ──────────────────────────────────────────────────────────────
export function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

// ── validation ───────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateSignup({ email, password, name }) {
  const problems = [];
  const e = String(email || "").trim().toLowerCase();
  const p = String(password || "");
  const n = String(name || "").trim().slice(0, 60);
  if (!EMAIL_RE.test(e)) problems.push("a valid email is required");
  if (p.length < 8) problems.push("password must be at least 8 characters");
  if (p.length > 200) problems.push("password is too long");
  return { email: e, password: p, name: n, problems };
}
