-- Per-unit check-out / check-in.
--
-- Assignments can now target a single tracked unit instead of the whole item:
-- unit_id NULL keeps the existing item-level behaviour, unit_id set means that
-- one physical unit is out. Both live in the same history table so an item's
-- timeline stays in one place.
ALTER TABLE item_assignments
  ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES item_units(id) ON DELETE CASCADE;

-- The old index allowed one open assignment per item, which would have rejected
-- a second unit of the same item being checked out. Split it: one open
-- item-level assignment per item, and one open assignment per unit.
DROP INDEX IF EXISTS uq_item_assignment_open;

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_assignment_open_item
  ON item_assignments (item_id) WHERE checked_in_at IS NULL AND unit_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_assignment_open_unit
  ON item_assignments (unit_id) WHERE checked_in_at IS NULL AND unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_item_assignments_unit
  ON item_assignments (unit_id, checked_out_at DESC);
