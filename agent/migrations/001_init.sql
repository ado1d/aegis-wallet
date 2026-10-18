-- Aegis product mode — initial schema.
-- UUIDs are generated in JS (crypto.randomUUID) so no pgcrypto dependency.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Both embedded wallets (primary vault owner + savings pot), each stored
-- twice: encrypted with the user's password (self-custody export) and with
-- AEGIS_SERVER_SECRET (relayer signing copy). No plaintext keys at rest.
CREATE TABLE IF NOT EXISTS keystores (
  user_id                   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  primary_address           TEXT NOT NULL,
  primary_keystore_user     JSONB NOT NULL,
  primary_keystore_server   JSONB NOT NULL,
  savings_address           TEXT NOT NULL,
  savings_keystore_user     JSONB NOT NULL,
  savings_keystore_server   JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS vaults (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address   TEXT,
  deploy_tx TEXT,
  state     TEXT NOT NULL DEFAULT 'pending', -- pending|deploying|configuring|transferring|seeding|done|error
  error     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS activities (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- command | provision | owner-op | key-export | system
  text        TEXT,
  decision    TEXT,                   -- execute | queue | reject | swap | query | clarify
  explanation TEXT,
  tx_hash     TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_user_idx ON activities (user_id, id DESC);

CREATE TABLE IF NOT EXISTS payees (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  address    TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'other',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, address)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,           -- approval | blocked | provision | owner-op | system
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, id DESC);
