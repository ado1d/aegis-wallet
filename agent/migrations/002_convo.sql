-- v3.9 — per-user conversation memory (multi-turn chat) persisted so
-- serverless deployments (Vercel functions) survive cold starts with pending
-- clarify rounds intact. The RAM cache stays the hot path inside a process;
-- this row is the cross-instance/cold-start recovery copy. `pending` holds
-- half-filled transfer slots {token, amount, recipient, at} — the same
-- SECURITY INVARIANT applies as in RAM: slots only ever FILL a transfer the
-- current message triggers or continues; nothing executes from memory alone.
CREATE TABLE IF NOT EXISTS user_convo (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
