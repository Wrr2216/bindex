-- Per-unit records: multiple physical units of one item (SKU), each with its
-- own serial, status, location and current holder. Item quantity = unit count.
CREATE TABLE IF NOT EXISTS item_units (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id                uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  serial                 text,
  status                 text NOT NULL DEFAULT 'active',
  location_id            uuid REFERENCES locations(id) ON DELETE SET NULL,
  utilized_by_entity_id  uuid REFERENCES entities(id) ON DELETE SET NULL,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_item_units_item ON item_units (item_id);
-- A serial identifies exactly one unit (so scanning resolves unambiguously).
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_units_serial ON item_units (serial) WHERE serial IS NOT NULL;
