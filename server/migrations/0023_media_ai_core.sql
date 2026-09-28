-- T02: attachments and signatures that any record can carry.
--
-- The owner is polymorphic (owner_type + owner_id) so a job, a claim or an
-- inspection added later can hold photos without a migration here. That rules
-- out a foreign key; attachments whose owner has gone are removed by a
-- background sweep instead (see services/media-ai-core/sweeper.ts), which also
-- keeps a JSON restore, which deletes and re-inserts every item, from taking
-- the photos with it.

CREATE TABLE IF NOT EXISTS attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type   text NOT NULL,
  owner_id     uuid NOT NULL,
  kind         text NOT NULL,
  stage        text,
  caption      text,
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,
  storage      text NOT NULL,
  bytes        bytea,
  path         text,
  width        integer,
  height       integer,
  duration_ms  integer,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check
  CHECK (kind IN ('photo', 'video', 'audio', 'document', 'signature'));

-- Exactly one place holds the bytes.
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_storage_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_storage_check
  CHECK (
    (storage = 'db' AND bytes IS NOT NULL AND path IS NULL)
    OR (storage = 'disk' AND path IS NOT NULL AND bytes IS NULL)
  );

-- Photos and video are already compressed, so TOAST compression only burns
-- CPU. Uncompressed out-of-line storage also lets substring() read just the
-- requested byte range, which is what a video seek asks for.
ALTER TABLE attachments ALTER COLUMN bytes SET STORAGE EXTERNAL;

CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments (owner_type, owner_id, created_at);

CREATE TABLE IF NOT EXISTS signatures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type      text NOT NULL,
  owner_id        uuid NOT NULL,
  signer_name     text NOT NULL,
  signer_email    text,
  signer_role     text,
  -- The exact words the signer agreed to.
  statement       text NOT NULL,
  -- sha256 of the canonical JSON of what was signed. Recomputing it over the
  -- record as it is now shows whether anything changed after signing.
  content_hash    text NOT NULL,
  -- The canonical snapshot itself, so a failed verification can say what the
  -- signer actually saw.
  content         jsonb,
  -- Restrict, not set null: a signature must not quietly lose its image.
  attachment_id   uuid REFERENCES attachments(id) ON DELETE RESTRICT,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  ip              text,
  user_agent      text,
  -- Null for someone without an account, such as a customer at delivery.
  signed_by_user  text
);

CREATE INDEX IF NOT EXISTS idx_signatures_owner ON signatures (owner_type, owner_id, signed_at);
