// Product-mode persistence — one repository interface, two backends:
//
//   Postgres  (DATABASE_URL set)  — Neon / Render / local docker. Survives
//                                   restarts; this is what production uses.
//   Memory    (no DATABASE_URL)   — zero-dependency fallback for local play
//                                   and tests. Everything works, but users and
//                                   history are lost when the process exits.
//                                   The server logs a loud warning about this.
//
// Shape of a user record:  { id, email, name, passwordHash, createdAt }
// Keystores row holds BOTH embedded wallets (primary + savings) in two
// envelopes each: one encrypted with the user's password (self-custody
// export), one with AEGIS_SERVER_SECRET (the relayer's signing copy).
// Plaintext private keys are NEVER stored — see src/auth.js.

import { randomUUID } from "node:crypto";
import { config } from "./config.js";

// ── schema (Postgres) ────────────────────────────────────────────────────────
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

// ── in-memory backend ────────────────────────────────────────────────────────
class MemoryStore {
  constructor() {
    this.kind = "memory";
    this.users = new Map(); // id -> user
    this.usersByEmail = new Map();
    this.keystores = new Map(); // userId -> row
    this.vaults = new Map(); // userId -> row
    this.sessions = new Map(); // token -> {userId, expiresAt}
    this.activities = new Map(); // userId -> [entry] (ascending)
    this.payees = new Map(); // userId -> [row]
    this.notifications = new Map(); // userId -> [row]
    this.convos = new Map(); // userId -> {turns, pending} (v3.9 convo persistence)
    this.seq = 0;
  }
  async ping() { return true; }
  async close() {}

  async createUser({ email, name, passwordHash }) {
    if (this.usersByEmail.has(email)) throw new Error("email already registered");
    const user = { id: randomUUID(), email, name, passwordHash, createdAt: new Date().toISOString() };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user);
    return user;
  }
  async getUserByEmail(email) { return this.usersByEmail.get(email) || null; }
  async getUserById(id) { return this.users.get(id) || null; }

  async saveKeystores(row) { this.keystores.set(row.userId, { ...row }); }
  async getKeystores(userId) { return this.keystores.get(userId) || null; }

  async upsertVault(row) {
    const prev = this.vaults.get(row.userId) || {};
    this.vaults.set(row.userId, { ...prev, ...row, updatedAt: new Date().toISOString() });
    return this.vaults.get(row.userId);
  }
  async getVault(userId) { return this.vaults.get(userId) || null; }
  async listProvisioning() {
    return [...this.vaults.values()].filter((v) => v.state !== "done");
  }
  async listVaultsWithAddress() {
    return [...this.vaults.values()].filter((v) => v.address);
  }

  async createSession({ token, userId, expiresAt }) {
    this.sessions.set(token, { userId, expiresAt: expiresAt.toISOString() });
  }
  async getSession(token) {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (new Date(s.expiresAt) < new Date()) { this.sessions.delete(token); return null; }
    return { token, userId: s.userId, expiresAt: s.expiresAt };
  }
  async deleteSession(token) { this.sessions.delete(token); }
  async purgeExpiredSessions() {
    const now = new Date();
    for (const [t, s] of this.sessions) if (new Date(s.expiresAt) < now) this.sessions.delete(t);
  }

  async addActivity(e) {
    const list = this.activities.get(e.userId) || [];
    const row = { id: ++this.seq, ...e, createdAt: new Date().toISOString() };
    list.push(row);
    this.activities.set(e.userId, list.slice(-500));
    return row;
  }
  async listActivities(userId, limit = 50) {
    return (this.activities.get(userId) || []).slice(-limit).reverse();
  }

  async addPayee(e) {
    const list = this.payees.get(e.userId) || [];
    if (list.some((p) => p.address.toLowerCase() === e.address.toLowerCase())) return;
    list.push({ id: ++this.seq, ...e, createdAt: new Date().toISOString() });
    this.payees.set(e.userId, list);
  }
  async listPayees(userId) { return [...(this.payees.get(userId) || [])]; }
  async deletePayee(userId, address) {
    const list = this.payees.get(userId) || [];
    this.payees.set(userId, list.filter((p) => p.address.toLowerCase() !== address.toLowerCase()));
  }

  async addNotification(e) {
    const list = this.notifications.get(e.userId) || [];
    list.push({ id: ++this.seq, read: false, ...e, createdAt: new Date().toISOString() });
    this.notifications.set(e.userId, list.slice(-200));
  }
  async listNotifications(userId, limit = 30) {
    return (this.notifications.get(userId) || []).slice(-limit).reverse();
  }
  async markNotificationRead(userId, id) {
    const list = this.notifications.get(userId) || [];
    const n = list.find((x) => String(x.id) === String(id));
    if (n) n.read = true;
  }

  async getConvoState(userId) { return this.convos.get(userId) || null; }
  async setConvoState(userId, state) { this.convos.set(userId, { turns: state.turns, pending: state.pending }); }

  // ── cross-task leases (in-memory backend: per-process map of promises) ────
  async acquireLease(key, holder, ttlMs = 150_000, waitMs = 60_000) {
    if (!this._leaseChains) this._leaseChains = new Map();
    const deadline = Date.now() + waitMs;
    while (this._leaseChains.has(key) && Date.now() < deadline) {
      // wake up on holder release OR on a short timer — never block past the deadline
      await Promise.race([
        this._leaseChains.get(key).catch(() => {}),
        new Promise((r) => setTimeout(r, Math.min(250, Math.max(20, deadline - Date.now())))),
      ]);
    }
    if (this._leaseChains.has(key)) return { ok: false };
    let release;
    const p = new Promise((res) => (release = res));
    this._leaseChains.set(key, p);
    return {
      ok: true,
      release: async () => { if (this._leaseChains.get(key) === p) this._leaseChains.delete(key); release(); },
    };
  }

  async stats() {
    return {
      users: this.users.size,
      vaultsDone: [...this.vaults.values()].filter((v) => v.state === "done").length,
      sessions: this.sessions.size,
    };
  }
}

// ── Postgres backend (node-postgres) ─────────────────────────────────────────
class PgStore {
  constructor(pool) {
    this.kind = "pg";
    this.pool = pool;
    this._leaseTablePromise = null;
  }
  async ping() { await this.pool.query("SELECT 1"); return true; }
  async close() { await this.pool.end(); }

  /** Idempotent CREATE for the lease table (memoized; safe under concurrency
   *  because every caller awaits the same promise). Also covered by migration
   *  003 for clean-slate deploys. */
  _ensureLeaseTable() {
    if (!this._leaseTablePromise) {
      this._leaseTablePromise = this.pool
        .query(
          `CREATE TABLE IF NOT EXISTS chain_leases (
             key text PRIMARY KEY,
             holder text NOT NULL,
             expires_at timestamptz NOT NULL
           )`
        )
        .catch((err) => { this._leaseTablePromise = null; throw err; });
    }
    return this._leaseTablePromise;
  }

  /** Cross-INSTANCE lease (serverless: several functions share the agent key).
   *  Atomic upsert-or-steal-expired; polls until acquired or waitMs elapses.
   *  Returns { ok, release } — release is always safe to call. */
  async acquireLease(key, holder, ttlMs = 150_000, waitMs = 60_000) {
    await this._ensureLeaseTable();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { rows } = await this.pool
        .query(
          `INSERT INTO chain_leases (key, holder, expires_at)
           VALUES ($1, $2, now() + make_interval(secs => $3))
           ON CONFLICT (key) DO UPDATE
             SET holder = $2, expires_at = now() + make_interval(secs => $3)
             WHERE chain_leases.expires_at <= now()
           RETURNING holder`,
          [key, holder, ttlMs / 1000]
        )
        .catch(() => ({ rows: [] })); // table momentarily unavailable → treat as busy
      if (rows.length) {
        return {
          ok: true,
          release: async () => {
            await this.pool
              .query(`DELETE FROM chain_leases WHERE key = $1 AND holder = $2`, [key, holder])
              .catch(() => {});
          },
        };
      }
      if (Date.now() >= deadline) return { ok: false };
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  async createUser({ email, name, passwordHash }) {
    const id = randomUUID();
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, created_at`,
      [id, email, name, passwordHash]
    );
    const r = rows[0];
    return { id: r.id, email: r.email, name: r.name, passwordHash, createdAt: r.created_at.toISOString() };
  }
  async getUserByEmail(email) {
    const { rows } = await this.pool.query(`SELECT id, email, name, password_hash, created_at FROM users WHERE email=$1`, [email]);
    if (!rows.length) return null;
    const r = rows[0];
    return { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash, createdAt: r.created_at.toISOString() };
  }
  async getUserById(id) {
    const { rows } = await this.pool.query(`SELECT id, email, name, password_hash, created_at FROM users WHERE id=$1`, [id]);
    if (!rows.length) return null;
    const r = rows[0];
    return { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash, createdAt: r.created_at.toISOString() };
  }

  async saveKeystores(row) {
    await this.pool.query(
      `INSERT INTO keystores (user_id, primary_address, primary_keystore_user, primary_keystore_server,
         savings_address, savings_keystore_user, savings_keystore_server)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET primary_address=$2, primary_keystore_user=$3,
         primary_keystore_server=$4, savings_address=$5, savings_keystore_user=$6, savings_keystore_server=$7`,
      [row.userId, row.primaryAddress, row.primaryKeystoreUser, row.primaryKeystoreServer,
       row.savingsAddress, row.savingsKeystoreUser, row.savingsKeystoreServer]
    );
  }
  async getKeystores(userId) {
    const { rows } = await this.pool.query(`SELECT * FROM keystores WHERE user_id=$1`, [userId]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      userId,
      primaryAddress: r.primary_address,
      primaryKeystoreUser: r.primary_keystore_user,
      primaryKeystoreServer: r.primary_keystore_server,
      savingsAddress: r.savings_address,
      savingsKeystoreUser: r.savings_keystore_user,
      savingsKeystoreServer: r.savings_keystore_server,
    };
  }

  async upsertVault(row) {
    const { rows } = await this.pool.query(
      `INSERT INTO vaults (user_id, address, deploy_tx, state, error)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET address=COALESCE($2, vaults.address),
         deploy_tx=COALESCE($3, vaults.deploy_tx), state=$4, error=$5, updated_at=now()
       RETURNING *`,
      [row.userId, row.address || null, row.deployTx || null, row.state || "pending", row.error || null]
    );
    return this._vaultRow(rows[0]);
  }
  async getVault(userId) {
    const { rows } = await this.pool.query(`SELECT * FROM vaults WHERE user_id=$1`, [userId]);
    return rows.length ? this._vaultRow(rows[0]) : null;
  }
  async listProvisioning() {
    const { rows } = await this.pool.query(`SELECT * FROM vaults WHERE state <> 'done'`);
    return rows.map((r) => this._vaultRow(r));
  }
  async listVaultsWithAddress() {
    const { rows } = await this.pool.query(`SELECT * FROM vaults WHERE address IS NOT NULL`);
    return rows.map((r) => this._vaultRow(r));
  }
  _vaultRow(r) {
    return {
      userId: r.user_id, address: r.address, deployTx: r.deploy_tx,
      state: r.state, error: r.error, updatedAt: r.updated_at.toISOString(),
    };
  }

  async createSession({ token, userId, expiresAt }) {
    await this.pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`, [token, userId, expiresAt]);
  }
  async getSession(token) {
    const { rows } = await this.pool.query(`SELECT token, user_id, expires_at FROM sessions WHERE token=$1`, [token]);
    if (!rows.length) return null;
    const r = rows[0];
    if (r.expires_at < new Date()) { await this.deleteSession(token); return null; }
    return { token: r.token, userId: r.user_id, expiresAt: r.expires_at.toISOString() };
  }
  async deleteSession(token) { await this.pool.query(`DELETE FROM sessions WHERE token=$1`, [token]); }
  async purgeExpiredSessions() { await this.pool.query(`DELETE FROM sessions WHERE expires_at < now()`); }

  async addActivity(e) {
    const { rows } = await this.pool.query(
      `INSERT INTO activities (user_id, kind, text, decision, explanation, tx_hash, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [e.userId, e.kind, e.text ?? null, e.decision ?? null, e.explanation ?? null, e.txHash ?? null, JSON.stringify(e.detail ?? null)]
    );
    return { id: rows[0].id, ...e, createdAt: rows[0].created_at.toISOString() };
  }
  async listActivities(userId, limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT id, kind, text, decision, explanation, tx_hash, detail, created_at
       FROM activities WHERE user_id=$1 ORDER BY id DESC LIMIT $2`, [userId, limit]
    );
    return rows.map((r) => ({
      id: r.id, kind: r.kind, text: r.text, decision: r.decision, explanation: r.explanation,
      txHash: r.tx_hash, detail: r.detail, createdAt: r.created_at.toISOString(),
    }));
  }

  async addPayee(e) {
    await this.pool.query(
      `INSERT INTO payees (user_id, label, address, category) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, address) DO UPDATE SET label=$2, category=$4`,
      [e.userId, e.label, e.address, e.category || "other"]
    );
  }
  async listPayees(userId) {
    const { rows } = await this.pool.query(`SELECT id, label, address, category, created_at FROM payees WHERE user_id=$1 ORDER BY id`, [userId]);
    return rows.map((r) => ({ id: r.id, label: r.label, address: r.address, category: r.category, createdAt: r.created_at.toISOString() }));
  }
  async deletePayee(userId, address) {
    await this.pool.query(`DELETE FROM payees WHERE user_id=$1 AND lower(address)=lower($2)`, [userId, address]);
  }

  async addNotification(e) {
    await this.pool.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1,$2,$3,$4)`,
      [e.userId, e.kind, e.title, e.body || ""]);
  }
  async listNotifications(userId, limit = 30) {
    const { rows } = await this.pool.query(
      `SELECT id, kind, title, body, read, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, read: r.read, createdAt: r.created_at.toISOString() }));
  }
  async markNotificationRead(userId, id) {
    await this.pool.query(`UPDATE notifications SET read=true WHERE user_id=$1 AND id=$2`, [userId, id]);
  }

  // v3.9 — conversation memory (multi-turn chat) survives cold starts on
  // serverless hosting; RAM stays the hot path, this is the recovery copy.
  async getConvoState(userId) {
    const { rows } = await this.pool.query(`SELECT state FROM user_convo WHERE user_id=$1`, [userId]);
    return rows.length ? rows[0].state : null;
  }
  async setConvoState(userId, state) {
    await this.pool.query(
      `INSERT INTO user_convo (user_id, state) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET state=$2, updated_at=now()`,
      [userId, JSON.stringify(state)]
    );
  }

  async stats() {
    const { rows } = await this.pool.query(
      `SELECT (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM vaults WHERE state='done')::int AS vaults_done,
              (SELECT count(*) FROM sessions)::int AS sessions`
    );
    return { users: rows[0].users, vaultsDone: rows[0].vaults_done, sessions: rows[0].sessions };
  }
}

// ── singleton + migrations ───────────────────────────────────────────────────
let _store = null;

/** Only postgres://… URLs count. (Some environments export unrelated
 *  DATABASE_URL=file:… variables — ignore those, fall back to memory.) */
function pgUrl() {
  const u = config.databaseUrl || "";
  return /^(postgres|postgresql|postgis):\/\//i.test(u) ? u : "";
}

export function getStore() {
  if (_store) return _store;
  _store = new MemoryStore();
  return _store;
}

/** Boot the store. Must be awaited before first use in product mode. */
export async function initStore() {
  if (_store) return _store;
  const url = pgUrl();
  if (!url) {
    _store = new MemoryStore();
    console.warn("  [warn] no usable DATABASE_URL — using IN-MEMORY store (accounts vanish on restart).");
    return _store;
  }
  const { default: pg } = await import("pg");
  const u = new URL(url);
  const isLocal = /^(localhost|127\.0\.0\.1|::1|host\.docker\.internal)$/.test(u.hostname);
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: isLocal ? undefined : { rejectUnauthorized: false }, // Neon & friends
  });
  _store = new PgStore(pool);
  return _store;
}

/** Apply pending SQL migrations (idempotent). Used by `npm run migrate`. */
export async function migrate() {
  const url = pgUrl();
  if (!url) throw new Error("migrate requires a postgres:// DATABASE_URL");
  const { default: pg } = await import("pg");
  const u = new URL(url);
  const isLocal = /^(localhost|127\.0\.0\.1|::1|host\.docker\.internal)$/.test(u.hostname);
  const client = new pg.Client({ connectionString: url, ssl: isLocal ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
    const { readFile, readdir } = await import("node:fs/promises");
    const files = (await readdir(new URL(".", MIGRATIONS_DIR))).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const version = Number(f.split("_")[0]);
      const { rows } = await client.query(`SELECT 1 FROM schema_migrations WHERE version=$1`, [version]);
      if (rows.length) continue;
      const sql = await readFile(new URL(f, MIGRATIONS_DIR), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
        await client.query("COMMIT");
        console.log(`  migration ${f}: applied`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log("  database is up to date.");
  } finally {
    await client.end();
  }
}
