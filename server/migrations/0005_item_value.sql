-- Monetary value per item, stored as integer cents to avoid float rounding.
ALTER TABLE items ADD COLUMN IF NOT EXISTS value_cents bigint;
