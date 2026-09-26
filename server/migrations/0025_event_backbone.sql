-- T04: tamper-evident audit log, and outbound webhooks fed from it.
--
-- Every event the application publishes becomes one audit_log row. Rows are
-- hash-chained: each row stores the hash of the row before it and its own
-- hash = sha256(prev_hash || canonical text of the row). The chaining happens
-- here, in a trigger, rather than in the application, so two app replicas
-- writing at the same moment cannot both read the same head and fork the
-- chain. See docs/event-backbone.md for the canonical form and how to verify
-- an export offline.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS audit_log_id_seq;

CREATE TABLE IF NOT EXISTS audit_log (
  -- Assigned by the trigger while it holds the chain lock, never by a column
  -- default: a default is drawn before the lock is taken, so two concurrent
  -- inserts could commit in the opposite order to their ids and the chain
  -- would no longer follow id order.
  id            bigint PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_kind    text NOT NULL DEFAULT 'system'
                CHECK (actor_kind IN ('user', 'api_key', 'device', 'system')),
  actor_id      text,
  actor_name    text,
  type          text NOT NULL,
  subject_type  text,
  subject_id    text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash     text NOT NULL,
  hash          text NOT NULL,
  -- A subject is a pair or nothing; half of one could not be exported in the
  -- { type, id } shape the offline verifier hashes.
  CONSTRAINT audit_log_subject_pair CHECK ((subject_type IS NULL) = (subject_id IS NULL))
);

ALTER SEQUENCE audit_log_id_seq OWNED BY audit_log.id;

CREATE INDEX IF NOT EXISTS idx_audit_log_subject ON audit_log (subject_type, subject_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_type ON audit_log (type text_pattern_ops, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred ON audit_log (occurred_at);

-- The text that gets hashed. A JSON array in a fixed field order, rendered by
-- jsonb's own output function, which is stable and fully specified (object
-- keys sorted by byte length then bytes, ", " and ": " separators). The
-- application carries an exact twin of this in
-- server/src/services/event-backbone/canonical.ts so an export can be checked
-- without a database.
CREATE OR REPLACE FUNCTION audit_log_canonical(r audit_log) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(
    r.id,
    to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    r.actor_kind,
    r.actor_id,
    r.actor_name,
    r.type,
    r.subject_type,
    r.subject_id,
    r.data
  )::text
$$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head text;
BEGIN
  -- Under REPEATABLE READ or SERIALIZABLE the head query below would read an
  -- old snapshot and fork the chain. Refuse rather than write a broken link.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit_log must be written under READ COMMITTED, not %',
      current_setting('transaction_isolation');
  END IF;

  -- One writer at a time, held until this transaction commits. The constant
  -- is arbitrary; it only has to be the same for every writer.
  PERFORM pg_advisory_xact_lock(7302640025);

  SELECT a.hash INTO head FROM audit_log a ORDER BY a.id DESC LIMIT 1;

  NEW.id := nextval('audit_log_id_seq');
  -- Millisecond precision so the value survives a round trip through a
  -- JavaScript Date unchanged, which the offline verifier relies on. Taken
  -- under the lock so time never runs backwards along the chain.
  NEW.occurred_at := date_trunc('milliseconds', clock_timestamp());
  NEW.prev_hash := coalesce(head, repeat('0', 64));
  NEW.hash := encode(digest(NEW.prev_hash || audit_log_canonical(NEW), 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Append-only. Archiving is a deliberate DBA procedure that disables this
-- trigger by name (docs/event-backbone.md), never something the app does.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING HINT = 'See docs/event-backbone.md for how to archive old entries.';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Event type patterns: '*' matches any run of characters, dots included, and
-- everything else matches literally. 'item.*' matches item.created and
-- item.unit.moved; '*' matches everything. The application has a twin in
-- server/src/services/event-backbone/patterns.ts.
CREATE OR REPLACE FUNCTION event_type_matches(event_type text, patterns text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM unnest(patterns) AS p
     WHERE event_type LIKE replace(replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_'), '*', '%')
  )
$$;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url              text NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- Kept in the clear because every delivery is signed with it. Never
  -- returned by the API after creation, and left out of backups.
  secret           text NOT NULL,
  event_patterns   text[] NOT NULL DEFAULT ARRAY['*'],
  active           boolean NOT NULL DEFAULT true,
  -- Consecutive failed attempts; reset by any success.
  failure_count    integer NOT NULL DEFAULT 0,
  disabled_at      timestamptz,
  disabled_reason  text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               bigserial PRIMARY KEY,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  -- Null for a test ping, which is sent once and never logged as an event.
  audit_log_id     bigint REFERENCES audit_log(id) ON DELETE SET NULL,
  event_type       text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz DEFAULT now(),
  -- Lease taken by the worker that is sending it, so a crashed worker's
  -- delivery is picked up again once the lease runs out.
  locked_until     timestamptz,
  response_status  integer,
  response_ms      integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries (next_attempt_at, id)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON webhook_deliveries (endpoint_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_audit
  ON webhook_deliveries (audit_log_id);
