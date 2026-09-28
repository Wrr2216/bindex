-- T12: condition records, condition sweeps and container captures.
--
-- Photos stay in the shared attachments table (owned by the item or unit, with
-- the report's stage), so an item's gallery, a claim and an inspection all see
-- the same pictures. Reports and captures only point at them by id.

-- ---------------------------------------------------------------------------
-- Condition sweeps
-- ---------------------------------------------------------------------------
-- A walk through one location recording the condition of each thing in it.
-- Kept as a row so a sweep survives a phone closing the tab, and so its
-- progress is exact (the reports carrying its id) rather than guessed by time.
CREATE TABLE IF NOT EXISTS condition_sweeps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
  name          text,
  stage         text NOT NULL DEFAULT 'inspection',
  status        text NOT NULL DEFAULT 'open',
  started_by    text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     text,
  closed_at     timestamptz
);

ALTER TABLE condition_sweeps DROP CONSTRAINT IF EXISTS condition_sweeps_stage_check;
ALTER TABLE condition_sweeps ADD CONSTRAINT condition_sweeps_stage_check
  CHECK (stage IN ('before', 'after', 'inspection'));
ALTER TABLE condition_sweeps DROP CONSTRAINT IF EXISTS condition_sweeps_status_check;
ALTER TABLE condition_sweeps ADD CONSTRAINT condition_sweeps_status_check
  CHECK (status IN ('open', 'closed'));

CREATE INDEX IF NOT EXISTS idx_condition_sweeps_open
  ON condition_sweeps (started_at DESC) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Condition reports
-- ---------------------------------------------------------------------------
-- One observation of an item's (or one unit's) condition at a point in time.
-- Claims (T16) read this table directly when it exists, so its column names
-- are part of the contract documented in docs/ai-condition.md.
CREATE TABLE IF NOT EXISTS condition_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id         uuid REFERENCES item_units(id) ON DELETE CASCADE,
  stage           text NOT NULL,
  -- The name of a custom stage ("pre-sale", "return"); null otherwise.
  stage_label     text,
  -- Null when the report only records a handling note or a remark.
  rating          text,
  notes           text,
  -- What the vision model said, kept apart from what the person wrote.
  ai_notes        text,
  -- [{ area, type, severity, description }]
  defects         jsonb NOT NULL DEFAULT '[]'::jsonb,
  handling_note   text,
  attachment_ids  uuid[] NOT NULL DEFAULT '{}',
  ai_assisted     boolean NOT NULL DEFAULT false,
  sweep_id        uuid REFERENCES condition_sweeps(id) ON DELETE SET NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE condition_reports DROP CONSTRAINT IF EXISTS condition_reports_stage_check;
ALTER TABLE condition_reports ADD CONSTRAINT condition_reports_stage_check
  CHECK (stage IN ('before', 'after', 'inspection', 'custom'));
ALTER TABLE condition_reports DROP CONSTRAINT IF EXISTS condition_reports_rating_check;
ALTER TABLE condition_reports ADD CONSTRAINT condition_reports_rating_check
  CHECK (rating IS NULL OR rating IN ('excellent', 'good', 'fair', 'poor', 'damaged'));
ALTER TABLE condition_reports DROP CONSTRAINT IF EXISTS condition_reports_defects_check;
ALTER TABLE condition_reports ADD CONSTRAINT condition_reports_defects_check
  CHECK (jsonb_typeof(defects) = 'array');

CREATE INDEX IF NOT EXISTS idx_condition_reports_item
  ON condition_reports (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_condition_reports_unit
  ON condition_reports (unit_id, created_at DESC) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_condition_reports_sweep
  ON condition_reports (sweep_id) WHERE sweep_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_condition_reports_recent
  ON condition_reports (created_at DESC);

-- ---------------------------------------------------------------------------
-- Container captures
-- ---------------------------------------------------------------------------
-- What was recorded when a box, tote or crate was packed: its size class, the
-- writing on it, its handling marks and the contents list as confirmed. The
-- latest capture of a container is what its handling marks come from.
CREATE TABLE IF NOT EXISTS container_captures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  size_class        text,
  handwritten_text  text,
  room              text,
  contents_summary  text,
  -- [{ name, category, qty, condition, fragile, description, itemId }]
  contents          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- fragile, this_side_up, high_value, heavy, keep_dry
  flags             text[] NOT NULL DEFAULT '{}',
  -- The model's own confidence per field, when AI read the photos.
  confidence        jsonb,
  ai_assisted       boolean NOT NULL DEFAULT false,
  attachment_ids    uuid[] NOT NULL DEFAULT '{}',
  created_item_ids  uuid[] NOT NULL DEFAULT '{}',
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE container_captures DROP CONSTRAINT IF EXISTS container_captures_contents_check;
ALTER TABLE container_captures ADD CONSTRAINT container_captures_contents_check
  CHECK (jsonb_typeof(contents) = 'array');

CREATE INDEX IF NOT EXISTS idx_container_captures_item
  ON container_captures (item_id, created_at DESC);
