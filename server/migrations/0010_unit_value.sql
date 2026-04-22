-- Per-unit monetary value (cents). The item's value rolls up to the sum of its
-- unit values when units exist.
ALTER TABLE item_units ADD COLUMN IF NOT EXISTS value_cents bigint;
