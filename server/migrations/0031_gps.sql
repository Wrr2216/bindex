-- GPS trackers, maps and geofences. Built on the tracking core (0022): fixes are
-- stored as sightings with tech 'gps', and a tracker is a tracking_devices row of
-- kind 'gps_tracker'. This adds the fences, what each tracker knows about them,
-- the tracker's own lifecycle, and its links to shipments (0024).

-- ---------------------------------------------------------------------------
-- Geofences
-- ---------------------------------------------------------------------------
-- A circle (GeoJSON Point plus radius_m) or a polygon (GeoJSON Polygon, holes
-- allowed). Geometry is plain jsonb and tested in the application: fences are
-- few and small, so there is no need for PostGIS. A fence linked to a location
-- is that location on the map; an asset entering it can be moved there.
CREATE TABLE IF NOT EXISTS geofences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  kind           text NOT NULL,
  geometry       jsonb NOT NULL,
  radius_m       double precision,
  location_id    uuid REFERENCES locations(id) ON DELETE SET NULL,
  active         boolean NOT NULL DEFAULT true,
  -- How long a tracker must stay on the other side of the edge before an
  -- entry or exit counts, so one stray fix does not fire anything.
  dwell_seconds  integer NOT NULL DEFAULT 30,
  color          text,
  notes          text,
  -- When the shape (or active flag) last changed. Trackers that last reported
  -- before this learn which side they are on without firing an event.
  geometry_at    timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE geofences DROP CONSTRAINT IF EXISTS geofences_kind_check;
ALTER TABLE geofences ADD CONSTRAINT geofences_kind_check CHECK (kind IN ('circle', 'polygon'));
ALTER TABLE geofences DROP CONSTRAINT IF EXISTS geofences_shape_check;
ALTER TABLE geofences ADD CONSTRAINT geofences_shape_check CHECK (
  (kind = 'circle' AND radius_m > 0 AND geometry->>'type' = 'Point')
  OR (kind = 'polygon' AND geometry->>'type' = 'Polygon')
);
ALTER TABLE geofences DROP CONSTRAINT IF EXISTS geofences_dwell_check;
ALTER TABLE geofences ADD CONSTRAINT geofences_dwell_check CHECK (dwell_seconds BETWEEN 0 AND 86400);

CREATE INDEX IF NOT EXISTS idx_geofences_location ON geofences (location_id) WHERE location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Trackers
-- ---------------------------------------------------------------------------
-- One row per GPS tracker (created on its first fix or first assignment). The
-- lifecycle: available, assigned to a shipment or vehicle, awaiting return
-- after a single-use tracker's shipment is delivered, or disposed. The rest is
-- the jump filter's memory: the last accepted fix, a run of rejected fixes that
-- agree with each other, and the recent fixes that give an average speed.
CREATE TABLE IF NOT EXISTS gps_trackers (
  device_id          uuid PRIMARY KEY REFERENCES tracking_devices(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'available',
  status_at          timestamptz NOT NULL DEFAULT now(),
  last_lat           double precision,
  last_lng           double precision,
  last_accuracy_m    real,
  last_fix_at        timestamptz,
  reject_streak      integer NOT NULL DEFAULT 0,
  reject_lat         double precision,
  reject_lng         double precision,
  reject_accuracy_m  real,
  reject_at          timestamptz,
  recent             jsonb NOT NULL DEFAULT '[]'::jsonb,
  battery_alerted    boolean NOT NULL DEFAULT false,
  -- Server time fences were last tested against this tracker's fixes. A fence
  -- whose shape changed after this has never seen the tracker.
  evaluated_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE gps_trackers DROP CONSTRAINT IF EXISTS gps_trackers_status_check;
ALTER TABLE gps_trackers ADD CONSTRAINT gps_trackers_status_check
  CHECK (status IN ('available', 'assigned', 'awaiting_return', 'disposed'));

-- Which side of each fence a tracker is on. No row means outside with nothing
-- pending, so only trackers inside a fence, or about to cross, take a row.
CREATE TABLE IF NOT EXISTS geofence_states (
  device_id       uuid NOT NULL REFERENCES tracking_devices(id) ON DELETE CASCADE,
  geofence_id     uuid NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  inside          boolean NOT NULL,
  since           timestamptz,
  pending_inside  boolean,
  pending_since   timestamptz,
  pending_lat     double precision,
  pending_lng     double precision,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, geofence_id)
);

CREATE INDEX IF NOT EXISTS idx_geofence_states_fence ON geofence_states (geofence_id);

-- Every confirmed entry and exit. History, pruned with sightings. The fence's
-- name is kept so an entry still reads after the fence is deleted.
CREATE TABLE IF NOT EXISTS geofence_events (
  id             bigserial PRIMARY KEY,
  geofence_id    uuid REFERENCES geofences(id) ON DELETE SET NULL,
  geofence_name  text NOT NULL,
  location_id    uuid,
  device_id      uuid,
  item_id        uuid,
  unit_id        uuid,
  shipment_ids   uuid[] NOT NULL DEFAULT '{}'::uuid[],
  kind           text NOT NULL,
  -- When the tracker crossed (its first fix on the new side), and when the
  -- crossing was confirmed after the fence's dwell time.
  occurred_at    timestamptz NOT NULL,
  confirmed_at   timestamptz NOT NULL,
  lat            double precision,
  lng            double precision,
  -- The audit-log entry the event was published as.
  audit_id       bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE geofence_events DROP CONSTRAINT IF EXISTS geofence_events_kind_check;
ALTER TABLE geofence_events ADD CONSTRAINT geofence_events_kind_check CHECK (kind IN ('entered', 'exited'));

CREATE INDEX IF NOT EXISTS idx_geofence_events_fence ON geofence_events (geofence_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_events_device ON geofence_events (device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_events_occurred ON geofence_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_geofence_events_shipments ON geofence_events USING gin (shipment_ids);

-- ---------------------------------------------------------------------------
-- Tracker links
-- ---------------------------------------------------------------------------
-- A tracker travels with one shipment, or is fitted to a vehicle (a location)
-- and so follows every open shipment on that vehicle. Origin and destination
-- fences default to the fences of the job's origin and destination locations;
-- set them here to override. Ended links are kept as the assignment history.
CREATE TABLE IF NOT EXISTS gps_tracker_links (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id                uuid NOT NULL REFERENCES tracking_devices(id) ON DELETE CASCADE,
  shipment_id              uuid REFERENCES shipments(id) ON DELETE CASCADE,
  vehicle_location_id      uuid REFERENCES locations(id) ON DELETE CASCADE,
  origin_geofence_id       uuid REFERENCES geofences(id) ON DELETE SET NULL,
  destination_geofence_id  uuid REFERENCES geofences(id) ON DELETE SET NULL,
  assigned_at              timestamptz NOT NULL DEFAULT now(),
  assigned_by              text,
  ended_at                 timestamptz,
  end_reason               text,
  ended_by                 text
);

ALTER TABLE gps_tracker_links DROP CONSTRAINT IF EXISTS gps_tracker_links_target_check;
ALTER TABLE gps_tracker_links ADD CONSTRAINT gps_tracker_links_target_check
  CHECK ((shipment_id IS NULL) <> (vehicle_location_id IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_tracker_links_shipment
  ON gps_tracker_links (device_id, shipment_id) WHERE ended_at IS NULL AND shipment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_tracker_links_vehicle
  ON gps_tracker_links (device_id) WHERE ended_at IS NULL AND vehicle_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gps_tracker_links_device ON gps_tracker_links (device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gps_tracker_links_shipment ON gps_tracker_links (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gps_tracker_links_vehicle
  ON gps_tracker_links (vehicle_location_id) WHERE vehicle_location_id IS NOT NULL;
