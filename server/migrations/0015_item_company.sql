-- Decouple item ownership from physical placement: company now lives on the
-- item (and its tracked units) directly, independent of where it sits.
-- locations.company_id remains as a default source when placing an item in a
-- container, but is no longer the source of truth for item ownership.
ALTER TABLE items ADD COLUMN company_id uuid;
ALTER TABLE item_units ADD COLUMN company_id uuid;
