-- 003: cross-instance send/provision leases.
-- Serverless deployments (Vercel) run several function instances against the
-- SAME agent key; each instance owns an in-memory NonceManager, so concurrent
-- broadcasts collide on nonces (observed 2026-10-18: chat txs replaced by
-- concurrent provisioning txs; provisioning steps reverted NotOwner after a
-- racing transferOwnership mined first). chain.js now serializes every send
-- per signing key through a lease row in this table, and provision.js claims
-- a per-user lease so two instances never provision the same vault at once.
CREATE TABLE IF NOT EXISTS chain_leases (
  key        text PRIMARY KEY,
  holder     text NOT NULL,
  expires_at timestamptz NOT NULL
);
