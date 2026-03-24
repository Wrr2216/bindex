-- Entities: who/what is currently utilizing an asset (customers, departments,
-- people, sites). A list managed inside this app; items optionally point at one.
CREATE TABLE IF NOT EXISTS entities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS utilized_by_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_items_utilized_by ON items (utilized_by_entity_id);
