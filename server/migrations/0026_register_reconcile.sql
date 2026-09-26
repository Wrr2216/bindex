-- T05: asset register import and reconciliation.
--
-- A register is someone else's list of what should exist (an IT asset
-- management export, a fixed-asset ledger, a Homebox or Snipe-IT export). It is
-- stored as uploaded, with the original cells kept in `raw` and the columns we
-- match on normalised alongside, so a mapping can be changed later without
-- asking for the file again.
--
-- Idempotent: every statement can run against a database that already has it.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS register_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  -- generic | snipeit | homebox | erp
  source_preset   text NOT NULL DEFAULT 'generic',
  file_name       text,
  -- csv | xlsx
  file_format     text NOT NULL,
  file_sha256     text NOT NULL,
  row_count       integer NOT NULL DEFAULT 0,
  headers         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { fieldKey: "Header in the file" }
  column_mapping  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_register_imports_created ON register_imports (created_at DESC);

CREATE TABLE IF NOT EXISTS register_rows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        uuid NOT NULL REFERENCES register_imports(id) ON DELETE CASCADE,
  -- Line in the spreadsheet as a person would count it: the header is row 1.
  row_number       integer NOT NULL,
  raw              jsonb NOT NULL,
  asset_tag        text,
  serial           text,
  epc              text,
  -- A printed code from this instance, when the register carries one.
  bindex_code      text,
  name             text,
  model            text,
  brand            text,
  category         text,
  description      text,
  location_text    text,
  custodian        text,
  cost_cents       bigint,
  purchase_date    date,
  quantity         integer,
  -- Cells that could not be read as the type their column promised.
  issues           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Changes copied from this instance into the register copy, so the report
  -- can list what to push back into the source system.
  edits            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_item_id  uuid REFERENCES items(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_register_rows_import_row ON register_rows (import_id, row_number);

-- Register location text that neither a path nor a name resolved, mapped once
-- by a person and remembered for every later import.
CREATE TABLE IF NOT EXISTS register_location_map (
  source_text  text PRIMARY KEY,
  display_text text NOT NULL,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id          uuid NOT NULL REFERENCES register_imports(id) ON DELETE CASCADE,
  scope_company_id   uuid REFERENCES companies(id) ON DELETE SET NULL,
  scope_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- Human-readable scope, kept so a run still explains itself after the
  -- group or location it was scoped to is renamed or deleted.
  scope_label        text,
  counts             jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms        integer,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_import ON reconciliation_runs (import_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  row_id                uuid REFERENCES register_rows(id) ON DELETE SET NULL,
  item_id               uuid REFERENCES items(id) ON DELETE SET NULL,
  unit_id               uuid REFERENCES item_units(id) ON DELETE SET NULL,
  -- matched | misplaced | conflict | register_only | bindex_only | duplicate | flagged_missing
  classes               text[] NOT NULL,
  -- asset_tag | serial | epc | asset_code, or null when nothing matched exactly
  match_method          text,
  register_location_id  uuid,
  bindex_location_id    uuid,
  proposal_item_id      uuid,
  proposal_score        real,
  conflicts             jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What the record looked like when the run was made.
  snapshot              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- null (open) | resolved | ignored
  resolution            text,
  resolution_note       text,
  resolved_by           text,
  resolved_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_results_run ON reconciliation_results (run_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_results_classes ON reconciliation_results USING gin (classes);

ALTER TABLE reconciliation_results DROP CONSTRAINT IF EXISTS reconciliation_results_resolution_check;
ALTER TABLE reconciliation_results ADD CONSTRAINT reconciliation_results_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('resolved', 'ignored'));
