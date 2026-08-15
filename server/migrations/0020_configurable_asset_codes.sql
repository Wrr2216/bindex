-- Make the printed asset-code prefix a setting instead of a constant.
--
-- The prefix appears on every label, so a deployment wants its own (ACME-4F2K1B,
-- HOME-9QX3TR). It is read from app_settings on each insert rather than baked
-- into the trigger, so changing it in Settings takes effect immediately.
--
-- Existing codes are never rewritten: a printed label has to keep resolving.

CREATE OR REPLACE FUNCTION asset_code_prefix() RETURNS text AS $$
  SELECT coalesce(
    nullif((SELECT value FROM app_settings WHERE key = 'codes.asset_prefix'), ''),
    'INV'
  );
$$ LANGUAGE sql STABLE;

-- Both generators pick a candidate that is free across items and units, so a
-- scanned code can only ever resolve to one record.
CREATE OR REPLACE FUNCTION gen_asset_code() RETURNS trigger AS $$
DECLARE candidate text;
BEGIN
  IF NEW.asset_code IS NULL
     OR EXISTS (SELECT 1 FROM item_units WHERE asset_code = NEW.asset_code) THEN
    LOOP
      candidate := asset_code_prefix() || '-' ||
        upper(substr(md5(NEW.id::text || clock_timestamp()::text || random()::text), 1, 6));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM items      WHERE asset_code = candidate)
            AND NOT EXISTS (SELECT 1 FROM item_units WHERE asset_code = candidate);
    END LOOP;
    NEW.asset_code := candidate;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gen_unit_asset_code() RETURNS trigger AS $$
DECLARE candidate text;
BEGIN
  IF NEW.asset_code IS NULL
     OR EXISTS (SELECT 1 FROM items WHERE asset_code = NEW.asset_code) THEN
    LOOP
      candidate := asset_code_prefix() || '-' ||
        upper(substr(md5(NEW.id::text || clock_timestamp()::text || random()::text), 1, 6));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM items      WHERE asset_code = candidate)
            AND NOT EXISTS (SELECT 1 FROM item_units WHERE asset_code = candidate);
    END LOOP;
    NEW.asset_code := candidate;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
