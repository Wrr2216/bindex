-- Tracking core: the devices that report where things are, every sighting they
-- report, and each asset's latest known position. RFID readers and portals use
-- it directly; BLE, GPS and placement build on the same three tables.

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
-- A fixed reader covers a zone (location_id). A tag or tracker is attached to an
-- asset (item_id, optionally unit_id). updates_location decides whether reads by
-- this device may change an item's recorded location, or only its position.
CREATE TABLE IF NOT EXISTS tracking_devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL,
  name              text NOT NULL,
  external_id       text,
  location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
  item_id           uuid REFERENCES items(id) ON DELETE SET NULL,
  unit_id           uuid REFERENCES item_units(id) ON DELETE SET NULL,
  updates_location  boolean NOT NULL DEFAULT false,
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- SHA-256 of the per-device ingest token, like api_keys.key_hash. The token
  -- itself is shown once when it is issued.
  token_hash        text,
  token_last4       text,
  battery_pct       integer,
  last_seen_at      timestamptz,
  last_lat          double precision,
  last_lng          double precision,
  disabled          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Every kind the BLE and GPS features need is listed now, so they never have to
-- migrate this constraint.
ALTER TABLE tracking_devices DROP CONSTRAINT IF EXISTS tracking_devices_kind_check;
ALTER TABLE tracking_devices ADD CONSTRAINT tracking_devices_kind_check
  CHECK (kind IN ('rfid_reader', 'rfid_portal', 'ble_gateway', 'ble_beacon', 'ble_tag',
                  'gps_tracker', 'nfc_reader', 'mobile'));

ALTER TABLE tracking_devices DROP CONSTRAINT IF EXISTS tracking_devices_battery_check;
ALTER TABLE tracking_devices ADD CONSTRAINT tracking_devices_battery_check
  CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100);

-- A reader serial, MAC or IMEI identifies one device of a kind.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_devices_kind_external
  ON tracking_devices (kind, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_devices_token
  ON tracking_devices (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracking_devices_external
  ON tracking_devices (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracking_devices_item
  ON tracking_devices (item_id) WHERE item_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Sightings
-- ---------------------------------------------------------------------------
-- An append-only log, pruned by age (SIGHTINGS_RETENTION_DAYS). It has no
-- foreign keys on purpose: it takes thousands of rows a second from a busy
-- portal, and a restore or a deleted reader should not rewrite history. Joins
-- that read it tolerate a reference to something that is gone.
CREATE TABLE IF NOT EXISTS sightings (
  id           bigserial PRIMARY KEY,
  observed_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  device_id    uuid,
  tech         text NOT NULL,
  code         text,
  item_id      uuid,
  unit_id      uuid,
  location_id  uuid,
  rssi         real,
  antenna      integer,
  direction    text,
  lat          double precision,
  lng          double precision,
  accuracy_m   real,
  speed_mps    real,
  heading_deg  real,
  meta         jsonb
);

ALTER TABLE sightings DROP CONSTRAINT IF EXISTS sightings_tech_check;
ALTER TABLE sightings ADD CONSTRAINT sightings_tech_check
  CHECK (tech IN ('rfid', 'ble', 'gps', 'nfc', 'barcode', 'manual'));
ALTER TABLE sightings DROP CONSTRAINT IF EXISTS sightings_direction_check;
ALTER TABLE sightings ADD CONSTRAINT sightings_direction_check
  CHECK (direction IS NULL OR direction IN ('in', 'out'));

CREATE INDEX IF NOT EXISTS idx_sightings_item_time
  ON sightings (item_id, observed_at DESC) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sightings_device_time
  ON sightings (device_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sightings_observed
  ON sightings (observed_at);

-- ---------------------------------------------------------------------------
-- Latest position per asset
-- ---------------------------------------------------------------------------
-- One row per item, or per item and unit when a unit carries its own tag. Only
-- ever moved forward in time, so a late batch cannot rewind it.
CREATE TABLE IF NOT EXISTS asset_positions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id               uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id               uuid REFERENCES item_units(id) ON DELETE CASCADE,
  tech                  text NOT NULL,
  location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,
  previous_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  lat                   double precision,
  lng                   double precision,
  device_id             uuid REFERENCES tracking_devices(id) ON DELETE SET NULL,
  observed_at           timestamptz NOT NULL,
  -- When the asset arrived in location_id, so dwell time is a subtraction.
  entered_at            timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- NULL unit ids compare equal here, so an item has exactly one item-level row.
-- Written as an expression rather than NULLS NOT DISTINCT so it works before
-- Postgres 15.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_positions_asset
  ON asset_positions (item_id, (COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX IF NOT EXISTS idx_asset_positions_location
  ON asset_positions (location_id) WHERE location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Code matching for hardware reads
-- ---------------------------------------------------------------------------
-- Readers disagree on how to print an EPC: upper or lower case, with or without
-- separators. A value made only of hex digits (ignoring spaces and colons) is
-- compared uppercased with the separators removed; anything else is compared
-- as typed. Mirrors normalizeCode() in services/tracking/normalize.ts.
CREATE OR REPLACE FUNCTION tracking_normalize_code(v text) RETURNS text AS $$
  SELECT CASE
    WHEN regexp_replace(v, '[[:space:]:]', '', 'g') ~ '^[0-9A-Fa-f]+$'
      THEN upper(regexp_replace(v, '[[:space:]:]', '', 'g'))
    ELSE btrim(v)
  END;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE INDEX IF NOT EXISTS idx_item_identifiers_tracking_code
  ON item_identifiers (tracking_normalize_code(value));
CREATE INDEX IF NOT EXISTS idx_item_units_tracking_serial
  ON item_units (tracking_normalize_code(serial)) WHERE serial IS NOT NULL;
