-- Per-unit printed identifier + label.
--
-- When an item has several physical units, each tracked unit now carries its own
-- generated asset code (same shape as an item's, so a 1D reader resolves it the same
-- way) plus an optional human label ("Unit 1", "Spare in Rack B"). Scanning a
-- unit code opens the item with that unit highlighted.
ALTER TABLE item_units ADD COLUMN IF NOT EXISTS asset_code text;
ALTER TABLE item_units ADD COLUMN IF NOT EXISTS label      text;

-- Backfill existing units, skipping any code already taken by an item or unit so
-- a scanned code never resolves to two different records.
DO $$
DECLARE
  r         record;
  candidate text;
BEGIN
  FOR r IN SELECT id FROM item_units WHERE asset_code IS NULL LOOP
    LOOP
      candidate := 'INV-' || upper(substr(md5(r.id::text || clock_timestamp()::text || random()::text), 1, 6));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM items      WHERE asset_code = candidate)
            AND NOT EXISTS (SELECT 1 FROM item_units WHERE asset_code = candidate);
    END LOOP;
    UPDATE item_units SET asset_code = candidate WHERE id = r.id;
  END LOOP;
END $$;

-- Safety net: generate a code for any insert that omits one, and replace a
-- supplied code that would collide with an item's.
CREATE OR REPLACE FUNCTION gen_unit_asset_code() RETURNS trigger AS $$
DECLARE candidate text;
BEGIN
  IF NEW.asset_code IS NULL
     OR EXISTS (SELECT 1 FROM items WHERE asset_code = NEW.asset_code) THEN
    LOOP
      candidate := 'INV-' || upper(substr(md5(NEW.id::text || clock_timestamp()::text || random()::text), 1, 6));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM items      WHERE asset_code = candidate)
            AND NOT EXISTS (SELECT 1 FROM item_units WHERE asset_code = candidate);
    END LOOP;
    NEW.asset_code := candidate;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS item_units_asset_code ON item_units;
CREATE TRIGGER item_units_asset_code BEFORE INSERT ON item_units
  FOR EACH ROW EXECUTE FUNCTION gen_unit_asset_code();

ALTER TABLE item_units ALTER COLUMN asset_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_units_asset_code ON item_units (asset_code);

-- The item-side generator gains the same cross-table check, so an item code can
-- never shadow a unit code either.
CREATE OR REPLACE FUNCTION gen_asset_code() RETURNS trigger AS $$
DECLARE candidate text;
BEGIN
  IF NEW.asset_code IS NULL
     OR EXISTS (SELECT 1 FROM item_units WHERE asset_code = NEW.asset_code) THEN
    LOOP
      candidate := 'INV-' || upper(substr(md5(NEW.id::text || clock_timestamp()::text || random()::text), 1, 6));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM items      WHERE asset_code = candidate)
            AND NOT EXISTS (SELECT 1 FROM item_units WHERE asset_code = candidate);
    END LOOP;
    NEW.asset_code := candidate;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
