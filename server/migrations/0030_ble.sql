-- Bluetooth beacons, gateways and room-level presence (T09).
--
-- Builds on the tracking core (0022): gateways, tags, room beacons and phones
-- are rows of tracking_devices, and every zone change is written through
-- recordSightings, so sightings, positions and "moved" events work as they do
-- for RFID. These tables hold only what the presence engine needs beyond that:
-- each tag's current room so a restart does not forget it, each phone's current
-- room, and the alerts the engine raises.

-- ---------------------------------------------------------------------------
-- Tag presence
-- ---------------------------------------------------------------------------
-- One row per tag the engine follows. tag_key is the ble_tag device's id, or
-- the tag's identity (ibeacon:..., eddystone:..., mac:...) when it is known only
-- through an item identifier. last_heard_at drives "missing"; it is written at
-- most every BLE_STORE_SECONDS, which is far shorter than the missing timeout.
CREATE TABLE IF NOT EXISTS ble_tag_state (
  tag_key               text PRIMARY KEY,
  device_id             uuid REFERENCES tracking_devices(id) ON DELETE CASCADE,
  identity              text NOT NULL,
  item_id               uuid REFERENCES items(id) ON DELETE CASCADE,
  unit_id               uuid REFERENCES item_units(id) ON DELETE SET NULL,
  -- The room the engine decided, and since when.
  location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,
  previous_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  zone_since            timestamptz,
  -- The gateway that heard it best when the room was decided, and how well.
  gateway_id            uuid REFERENCES tracking_devices(id) ON DELETE SET NULL,
  rssi                  real,
  last_heard_at         timestamptz NOT NULL,
  missing_since         timestamptz,
  -- From Eddystone-TLM frames. The percentage lives on the device row.
  battery_mv            integer,
  temperature_c         real,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ble_tag_state_location
  ON ble_tag_state (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ble_tag_state_item
  ON ble_tag_state (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ble_tag_state_device
  ON ble_tag_state (device_id) WHERE device_id IS NOT NULL;
-- The missing sweep reads only tags that are not already missing.
CREATE INDEX IF NOT EXISTS idx_ble_tag_state_heard
  ON ble_tag_state (last_heard_at) WHERE missing_since IS NULL;

-- ---------------------------------------------------------------------------
-- Phones in rooms
-- ---------------------------------------------------------------------------
-- The room a phone last placed itself in from the room beacons it heard, and
-- the person it belongs to. Only the current room is kept, never a history,
-- and it stops counting at expires_at.
CREATE TABLE IF NOT EXISTS ble_phone_rooms (
  device_id    uuid PRIMARY KEY REFERENCES tracking_devices(id) ON DELETE CASCADE,
  user_oid     text,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  beacon_id    uuid REFERENCES tracking_devices(id) ON DELETE SET NULL,
  rssi         real,
  entered_at   timestamptz NOT NULL,
  observed_at  timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ble_phone_rooms_user
  ON ble_phone_rooms (user_oid, expires_at DESC) WHERE user_oid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Alerts
-- ---------------------------------------------------------------------------
-- A missing tag or a low battery is one open alert until it resolves (the tag
-- is heard again, the battery is replaced); the partial unique indexes make
-- raising it idempotent across replicas. notified_at marks alerts already sent
-- in a digest.
CREATE TABLE IF NOT EXISTS ble_alerts (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  tag_key      text,
  device_id    uuid REFERENCES tracking_devices(id) ON DELETE CASCADE,
  item_id      uuid REFERENCES items(id) ON DELETE CASCADE,
  location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- Names as they were when the alert was raised, so a digest needs no joins.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  notified_at  timestamptz
);

ALTER TABLE ble_alerts DROP CONSTRAINT IF EXISTS ble_alerts_kind_check;
ALTER TABLE ble_alerts ADD CONSTRAINT ble_alerts_kind_check
  CHECK (kind IN ('missing', 'after_hours_move', 'battery_low'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_ble_alerts_open_missing
  ON ble_alerts (tag_key) WHERE kind = 'missing' AND resolved_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ble_alerts_open_battery
  ON ble_alerts (device_id) WHERE kind = 'battery_low' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ble_alerts_unnotified
  ON ble_alerts (id) WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ble_alerts_created
  ON ble_alerts (created_at DESC);
