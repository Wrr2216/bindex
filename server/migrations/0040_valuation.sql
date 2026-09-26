-- T19: valuation, high-value declarations, receipts, warranty and service.
--
-- Item-scoped tables (valuations, profiles, service plans and their log)
-- cascade with the item or unit they describe and travel in the JSON backup.
-- Declarations and receipts are records in their own right: their lines keep a
-- snapshot of what they describe and link to items softly (no foreign key), so
-- a signed declaration still says what was declared after an item is deleted,
-- and a restore that re-inserts items does not unlink them.

-- ---------------------------------------------------------------------------
-- Valuations: every value recorded for an item or unit. Never updated; the
-- newest row is the current value, the rest are its history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS valuations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id         uuid REFERENCES item_units(id) ON DELETE CASCADE,
  value_cents     bigint NOT NULL,
  -- The value the record held just before this one, so history reads as changes.
  previous_cents  bigint,
  currency        text NOT NULL,
  -- ai | web | receipt | manual | appraisal
  source          text NOT NULL,
  basis           text,
  confidence      real,
  low_cents       bigint,
  high_cents      bigint,
  valued_on       date NOT NULL DEFAULT current_date,
  -- What the estimate was based on: the AI reading (brand, model, materials,
  -- condition), the web price it was checked against, the photos it saw.
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE valuations DROP CONSTRAINT IF EXISTS valuations_source_check;
ALTER TABLE valuations ADD CONSTRAINT valuations_source_check
  CHECK (source IN ('ai', 'web', 'receipt', 'manual', 'appraisal'));
ALTER TABLE valuations DROP CONSTRAINT IF EXISTS valuations_value_check;
ALTER TABLE valuations ADD CONSTRAINT valuations_value_check
  CHECK (value_cents >= 0 AND (low_cents IS NULL OR low_cents >= 0) AND (high_cents IS NULL OR high_cents >= 0));
ALTER TABLE valuations DROP CONSTRAINT IF EXISTS valuations_confidence_check;
ALTER TABLE valuations ADD CONSTRAINT valuations_confidence_check
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

CREATE INDEX IF NOT EXISTS idx_valuations_item ON valuations (item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_valuations_unit ON valuations (unit_id, created_at) WHERE unit_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Profiles: purchase, warranty and usage facts for one item or one unit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS valuation_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id               uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id               uuid REFERENCES item_units(id) ON DELETE CASCADE,
  purchase_date         date,
  purchase_cents        bigint,
  vendor                text,
  -- The receipt the purchase facts came from. Soft link: see the note above.
  receipt_id            uuid,
  warranty_ends         date,
  warranty_terms        text,
  warranty_provider     text,
  -- auto follows the instance threshold; yes and no override it.
  high_value            text NOT NULL DEFAULT 'auto',
  -- Hour-meter reading, for service intervals counted in hours of use.
  usage_hours           numeric,
  usage_read_at         timestamptz,
  -- The warranty end date last announced by the digest, so each is announced once.
  warranty_alerted_for  date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE valuation_profiles DROP CONSTRAINT IF EXISTS valuation_profiles_high_value_check;
ALTER TABLE valuation_profiles ADD CONSTRAINT valuation_profiles_high_value_check
  CHECK (high_value IN ('auto', 'yes', 'no'));

-- One profile for the item itself and one per unit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_valuation_profiles_item
  ON valuation_profiles (item_id) WHERE unit_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_valuation_profiles_unit
  ON valuation_profiles (unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_valuation_profiles_warranty
  ON valuation_profiles (warranty_ends) WHERE warranty_ends IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Service plans: recurring work every N days and/or every N hours of use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id          uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id          uuid REFERENCES item_units(id) ON DELETE CASCADE,
  name             text NOT NULL,
  interval_days    integer,
  interval_hours   numeric,
  -- Counted from here until the first service is logged.
  starts_at        timestamptz NOT NULL DEFAULT now(),
  starts_hours     numeric,
  last_done_at     timestamptz,
  last_done_hours  numeric,
  notes            text,
  active           boolean NOT NULL DEFAULT true,
  -- The due point last announced by the digest ("<date>|<hours>").
  alerted_for      text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE service_plans DROP CONSTRAINT IF EXISTS service_plans_interval_check;
ALTER TABLE service_plans ADD CONSTRAINT service_plans_interval_check
  CHECK (
    (interval_days IS NOT NULL OR interval_hours IS NOT NULL)
    AND (interval_days IS NULL OR interval_days > 0)
    AND (interval_hours IS NULL OR interval_hours > 0)
  );

CREATE INDEX IF NOT EXISTS idx_service_plans_item ON service_plans (item_id);

CREATE TABLE IF NOT EXISTS service_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Kept when the plan is removed: the work was still done.
  plan_id     uuid REFERENCES service_plans(id) ON DELETE SET NULL,
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id     uuid REFERENCES item_units(id) ON DELETE CASCADE,
  plan_name   text,
  done_at     timestamptz NOT NULL DEFAULT now(),
  hours       numeric,
  cost_cents  bigint,
  notes       text,
  done_by     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_records_item ON service_records (item_id, done_at);

-- ---------------------------------------------------------------------------
-- Receipts. The file itself is an attachment owned by the receipt (T02).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- draft until a person confirms the lines and matches.
  status          text NOT NULL DEFAULT 'draft',
  vendor          text,
  purchase_date   date,
  currency        text,
  subtotal_cents  bigint,
  tax_cents       bigint,
  total_cents     bigint,
  -- The last AI reading, normalized, kept for reference after edits.
  reading         jsonb,
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  confirmed_by    text
);

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_status_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_status_check CHECK (status IN ('draft', 'confirmed'));

CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts (created_at);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id        uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  description       text NOT NULL,
  quantity          numeric NOT NULL DEFAULT 1,
  unit_price_cents  bigint,
  total_cents       bigint,
  sku               text,
  serial            text,
  warranty_months   integer,
  -- Soft links to what the line was matched to.
  item_id           uuid,
  unit_id           uuid,
  match_score       real,
  match_reason      text
);

CREATE INDEX IF NOT EXISTS idx_receipt_lines_receipt ON receipt_lines (receipt_id, position);
CREATE INDEX IF NOT EXISTS idx_receipt_lines_item ON receipt_lines (item_id) WHERE item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- High-value declarations (HVI-00001): a signed, dated list of items and the
-- values declared for them.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS hv_declaration_code_seq;

CREATE TABLE IF NOT EXISTS hv_declarations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL DEFAULT ('HVI-' || lpad(nextval('hv_declaration_code_seq')::text, 5, '0')),
  title           text NOT NULL,
  -- company | location | job. Jobs are a free-text reference (scope_label)
  -- until the jobs feature is merged; company and location carry scope_id.
  scope           text NOT NULL,
  scope_id        uuid,
  scope_label     text,
  status          text NOT NULL DEFAULT 'draft',
  currency        text NOT NULL,
  notes           text,
  signature_id    uuid,
  signed_at       timestamptz,
  -- The audit-log entry recording the signing: evidence held outside this row.
  audit_entry_id  bigint,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hv_declarations DROP CONSTRAINT IF EXISTS hv_declarations_scope_check;
ALTER TABLE hv_declarations ADD CONSTRAINT hv_declarations_scope_check
  CHECK (scope IN ('company', 'location', 'job'));
ALTER TABLE hv_declarations DROP CONSTRAINT IF EXISTS hv_declarations_status_check;
ALTER TABLE hv_declarations ADD CONSTRAINT hv_declarations_status_check
  CHECK (status IN ('draft', 'signed'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_hv_declarations_code ON hv_declarations (code);

CREATE TABLE IF NOT EXISTS hv_declaration_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id  uuid NOT NULL REFERENCES hv_declarations(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  -- Soft links; the snapshot below is what was declared.
  item_id         uuid,
  unit_id         uuid,
  valuation_id    uuid,
  name            text NOT NULL,
  brand           text,
  model           text,
  serial          text,
  asset_code      text,
  description     text,
  materials       text,
  condition       text,
  declared_cents  bigint NOT NULL,
  -- Where the declared value came from (ai, receipt, manual…), shown so an AI
  -- estimate is never mistaken for an appraisal.
  value_source    text,
  notes           text
);

ALTER TABLE hv_declaration_lines DROP CONSTRAINT IF EXISTS hv_declaration_lines_value_check;
ALTER TABLE hv_declaration_lines ADD CONSTRAINT hv_declaration_lines_value_check CHECK (declared_cents >= 0);

CREATE INDEX IF NOT EXISTS idx_hv_declaration_lines_decl ON hv_declaration_lines (declaration_id, position);
