-- NinjaOne sync + label printing additions.

-- Stable, human-friendly per-item code printed on labels and resolvable in-app.
ALTER TABLE items ADD COLUMN IF NOT EXISTS asset_code text;

-- Backfill existing rows deterministically.
UPDATE items
   SET asset_code = 'INV-' || upper(substr(md5(id::text), 1, 6))
 WHERE asset_code IS NULL;

-- Guarantee every future row gets one even if an insert path forgets to set it.
CREATE OR REPLACE FUNCTION gen_asset_code() RETURNS trigger AS $$
BEGIN
  IF NEW.asset_code IS NULL THEN
    NEW.asset_code := 'INV-' || upper(substr(md5(NEW.id::text || clock_timestamp()::text), 1, 6));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_asset_code ON items;
CREATE TRIGGER items_asset_code BEFORE INSERT ON items
  FOR EACH ROW EXECUTE FUNCTION gen_asset_code();

ALTER TABLE items ALTER COLUMN asset_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_asset_code ON items (asset_code);

-- NinjaOne linkage.
ALTER TABLE items ADD COLUMN IF NOT EXISTS ninjaone_device_id  bigint;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ninjaone_asset_id   text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ninjaone_org        text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ninjaone_synced_at  timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_ninjaone_device
  ON items (ninjaone_device_id) WHERE ninjaone_device_id IS NOT NULL;

-- Integration sync history (NinjaOne, future sources).
CREATE TABLE IF NOT EXISTS sync_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  created      integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  matched      integer NOT NULL DEFAULT 0,
  error        text
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs (source, started_at DESC);
