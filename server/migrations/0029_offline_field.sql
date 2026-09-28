-- Offline field mode (T08).
--
-- A device working in a dead zone queues its changes and replays them when it
-- reconnects. A replay can follow a request that did reach the server but whose
-- response never made it back, so each queued change carries an
-- Idempotency-Key, and this table remembers what the server answered to it.
-- A second request with the same key gets the stored answer instead of
-- applying the change again.
--
-- Rows are a cache, not a record: they expire after a day and are left out of
-- backups.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  -- Who sent it (user oid or api-key:<id>). Keys are scoped per caller, so one
  -- person can never be handed another person's stored response.
  principal     text        NOT NULL,
  key           text        NOT NULL,
  method        text        NOT NULL,
  path          text        NOT NULL,
  -- Hash of method, path and body. The same key on a different request is an
  -- error, not a replay.
  fingerprint   text        NOT NULL,
  state         text        NOT NULL DEFAULT 'pending',
  status        integer,
  content_type  text,
  body          bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (principal, key)
);

ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_state_check;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_check CHECK (state IN ('pending', 'done'));

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys (expires_at);
