-- Chain of custody and digital sign-off.
--
-- A custody transfer records one handoff: who released a set of items, who
-- received them, when and where, under which seals, and both parties'
-- signatures over a fingerprint of the exact list. An item's chain of custody
-- is the ordered list of completed transfers that include it.
--
-- Signed rows keep snapshots (names, codes, the place's name) rather than
-- relying on foreign keys alone: deleting a job or renaming a location later
-- must not change what someone signed for. Item and unit ids are therefore
-- plain columns, like job_item_stage_history, and the links to jobs,
-- shipments, places and holders are SET NULL and never part of the signed
-- content.
--
-- Every table is created IF NOT EXISTS and every constraint is dropped before
-- it is added, so the file can be applied twice.

-- Items (and containers) whose every handoff must be recorded. A container
-- covers what is packed inside it.
CREATE TABLE IF NOT EXISTS custody_controls (
  item_id  uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  reason   text,
  set_by   text,
  set_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custody_transfers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL,
  -- pickup, handoff, delivery, checkout, return, storage, release, or a later
  -- feature's own; checked for shape only.
  purpose               text NOT NULL DEFAULT 'handoff',
  -- draft: the list is being scanned. locked: the count is confirmed and the
  -- list is fixed; signatures are being collected. completed: every required
  -- party has signed. void: abandoned before completion.
  status                text NOT NULL DEFAULT 'draft',

  -- The two parties. kind is entity (a holder), user (an account) or external
  -- (anyone else, by name and organisation). name and org are snapshots.
  from_kind             text NOT NULL,
  from_entity_id        uuid REFERENCES entities(id) ON DELETE SET NULL,
  from_user_oid         text,
  from_name             text NOT NULL,
  from_org              text,
  to_kind               text NOT NULL,
  to_entity_id          uuid REFERENCES entities(id) ON DELETE SET NULL,
  to_user_oid           text,
  to_name               text NOT NULL,
  to_org                text,

  -- When custody changed hands: the moment the last required signature landed.
  at                    timestamptz,
  location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,
  location_name         text,
  lat                   double precision,
  lng                   double precision,
  accuracy_m            double precision,

  job_id                uuid REFERENCES jobs(id) ON DELETE SET NULL,
  job_code              text,
  shipment_id           uuid REFERENCES shipments(id) ON DELETE SET NULL,
  shipment_code         text,

  seal_numbers          text[] NOT NULL DEFAULT '{}'::text[],
  condition_note        text,
  notes                 text,

  -- sha256 of the canonical item list, set when the list is locked.
  content_hash          text,
  locked_at             timestamptz,
  -- Signatures live in the signatures table (owner custody_transfer); these
  -- say which one is whose. No foreign key: signatures are not in the JSON
  -- backup, and a restore onto another instance must not fail on them.
  from_signature_id     uuid,
  to_signature_id       uuid,
  -- How each signature was captured: { from: { via, capturedBy }, to: ... }.
  signing               jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The one-time signing link. Only a hash of the token is kept.
  link_token_hash       text,
  link_party            text,
  link_expires_at       timestamptz,
  link_created_by       text,
  link_used_at          timestamptz,

  -- The PDF receipt (an attachment of this transfer) and the audit-log entry
  -- that published it.
  receipt_attachment_id uuid,
  audit_entry_id        bigint,
  audit_hash            text,

  void_reason           text,
  voided_at             timestamptz,
  voided_by             text,
  completed_at          timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE custody_transfers DROP CONSTRAINT IF EXISTS custody_transfers_status_check;
ALTER TABLE custody_transfers ADD CONSTRAINT custody_transfers_status_check
  CHECK (status IN ('draft', 'locked', 'completed', 'void'));
ALTER TABLE custody_transfers DROP CONSTRAINT IF EXISTS custody_transfers_purpose_check;
ALTER TABLE custody_transfers ADD CONSTRAINT custody_transfers_purpose_check
  CHECK (purpose ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE custody_transfers DROP CONSTRAINT IF EXISTS custody_transfers_from_kind_check;
ALTER TABLE custody_transfers ADD CONSTRAINT custody_transfers_from_kind_check
  CHECK (from_kind IN ('entity', 'user', 'external'));
ALTER TABLE custody_transfers DROP CONSTRAINT IF EXISTS custody_transfers_to_kind_check;
ALTER TABLE custody_transfers ADD CONSTRAINT custody_transfers_to_kind_check
  CHECK (to_kind IN ('entity', 'user', 'external'));
ALTER TABLE custody_transfers DROP CONSTRAINT IF EXISTS custody_transfers_link_party_check;
ALTER TABLE custody_transfers ADD CONSTRAINT custody_transfers_link_party_check
  CHECK (link_party IS NULL OR link_party IN ('from', 'to'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_transfers_code ON custody_transfers (code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_transfers_link
  ON custody_transfers (link_token_hash) WHERE link_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custody_transfers_status ON custody_transfers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custody_transfers_job ON custody_transfers (job_id);
CREATE INDEX IF NOT EXISTS idx_custody_transfers_shipment ON custody_transfers (shipment_id);

-- The items handed over, in the order they were scanned. Order matters: it is
-- part of what is hashed and signed.
CREATE TABLE IF NOT EXISTS custody_transfer_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id     uuid NOT NULL REFERENCES custody_transfers(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  item_id         uuid NOT NULL,
  unit_id         uuid,
  asset_code      text NOT NULL,
  unit_code       text,
  name            text NOT NULL,
  -- scan (read at the handoff), contained (inside a scanned container),
  -- line (from a shipment's manifest), manual.
  via             text NOT NULL DEFAULT 'scan',
  -- The scanned container this one travels inside, for contained lines.
  parent_item_id  uuid,
  job_item_id     uuid REFERENCES job_items(id) ON DELETE SET NULL,
  -- accepted, missing, damaged, refused: what the receiving party found.
  outcome         text NOT NULL DEFAULT 'accepted',
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE custody_transfer_items DROP CONSTRAINT IF EXISTS custody_transfer_items_outcome_check;
ALTER TABLE custody_transfer_items ADD CONSTRAINT custody_transfer_items_outcome_check
  CHECK (outcome IN ('accepted', 'missing', 'damaged', 'refused'));
ALTER TABLE custody_transfer_items DROP CONSTRAINT IF EXISTS custody_transfer_items_via_check;
ALTER TABLE custody_transfer_items ADD CONSTRAINT custody_transfer_items_via_check
  CHECK (via IN ('scan', 'contained', 'line', 'manual'));
CREATE INDEX IF NOT EXISTS idx_custody_transfer_items_transfer ON custody_transfer_items (transfer_id, position);
CREATE INDEX IF NOT EXISTS idx_custody_transfer_items_item ON custody_transfer_items (item_id);
