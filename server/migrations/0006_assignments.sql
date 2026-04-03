-- Assignment history: who/what had an asset and when (check-out / check-in).
CREATE TABLE IF NOT EXISTS item_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  entity_id       uuid REFERENCES entities(id) ON DELETE SET NULL,
  entity_name     text NOT NULL, -- snapshot, survives entity rename/delete
  checked_out_at  timestamptz NOT NULL DEFAULT now(),
  checked_in_at   timestamptz,   -- NULL = still out
  checked_out_by  text,
  checked_in_by   text,
  note            text
);
CREATE INDEX IF NOT EXISTS idx_item_assignments_item
  ON item_assignments (item_id, checked_out_at DESC);
-- At most one open (un-returned) assignment per item.
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_assignment_open
  ON item_assignments (item_id) WHERE checked_in_at IS NULL;
