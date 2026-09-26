-- Consumables and equipment accountability.
--
-- Consumables (boxes, tape, pads, wrap) are ordinary items with a side record
-- saying how they are counted and when to reorder. Stock is held per location
-- in stock_levels, and every change to it is a row in stock_movements written
-- in the same transaction, so the level at a location always equals what the
-- movements say came in minus what went out.
--
-- Equipment (dollies, straps, lift gates) is checked out in kits: one scan
-- session to one crew, truck or branch. Each piece still gets its own
-- item_assignments row through the existing check-out path; a kit only groups
-- those rows and carries the expected return time.

CREATE TABLE IF NOT EXISTS consumable_items (
  item_id        uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  unit           text NOT NULL DEFAULT 'each',
  -- A location at or below this level is low. NULL means never alert.
  reorder_point  numeric(14,3),
  reorder_qty    numeric(14,3),
  supplier       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_levels (
  item_id      uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Not constrained to >= 0: an administrator may take it negative with a
  -- recorded adjustment (stock used before it was received). Every other path
  -- refuses in the service.
  qty          numeric(14,3) NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_levels_location ON stock_levels (location_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reason            text NOT NULL,
  -- Always positive; direction comes from which side has a location.
  qty               numeric(14,3) NOT NULL,
  from_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  to_location_id    uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- The crew, truck or branch the stock went to or came back from.
  holder_entity_id  uuid REFERENCES entities(id) ON DELETE SET NULL,
  holder_name       text, -- snapshot, survives a rename or delete
  -- What this movement did to the holder's outstanding balance: +qty on
  -- issue, -qty on return or on consumption out of what they were issued.
  holder_delta      numeric(14,3) NOT NULL DEFAULT 0,
  job_ref           text,
  note              text,
  -- Per-unit cost when the movement happened, so a later price change does
  -- not rewrite the cost of what was already used.
  unit_cost_cents   bigint,
  -- Cycle counts only: what was on file and what was found.
  expected_qty      numeric(14,3),
  counted_qty       numeric(14,3),
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_check
  CHECK (reason IN ('receive', 'issue', 'return', 'transfer', 'consume', 'adjust', 'count'));
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_qty_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_qty_check CHECK (qty >= 0);

CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_holder
  ON stock_movements (holder_entity_id, item_id) WHERE holder_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements (created_at);

CREATE TABLE IF NOT EXISTS equipment_kits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_entity_id    uuid REFERENCES entities(id) ON DELETE SET NULL,
  holder_name         text NOT NULL,
  expected_return_at  timestamptz,
  job_ref             text,
  note                text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Set once every piece is back.
  closed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_equipment_kits_holder ON equipment_kits (holder_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_equipment_kits_open ON equipment_kits (expected_return_at) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS equipment_kit_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_id         uuid NOT NULL REFERENCES equipment_kits(id) ON DELETE CASCADE,
  item_id        uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id        uuid REFERENCES item_units(id) ON DELETE CASCADE,
  -- The per-piece check-out record. Whether the piece is back is read from
  -- its checked_in_at, so a return made anywhere in the app counts here too.
  assignment_id  uuid REFERENCES item_assignments(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_equipment_kit_lines_kit ON equipment_kit_lines (kit_id);
CREATE INDEX IF NOT EXISTS idx_equipment_kit_lines_assignment ON equipment_kit_lines (assignment_id);

-- One row per calendar day the low-stock digest ran. Claiming the day with an
-- insert is what keeps it to once a day across restarts and replicas.
CREATE TABLE IF NOT EXISTS consumable_digest_runs (
  day       date PRIMARY KEY,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  low_count integer NOT NULL DEFAULT 0
);
