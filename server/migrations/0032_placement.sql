-- Room-based placement guidance and delivery matching.
--
-- Placement builds on jobs (job_items carry each line's destination) and on
-- the tracking core (sightings say which room a tag was read in). It keeps
-- three things of its own:
--
--   placement_room_map      per job, "this origin room goes to that destination
--                           room", used to propose destinations for lines that
--                           have none
--   placement_observations  every placement outcome worth keeping: a line placed,
--                           found in the wrong room (and which room), scanned off
--                           the wrong truck, or an item that belongs to another
--                           job. Stage changes themselves are recorded in
--                           job_item_stage_history by the jobs core; this table
--                           adds the room a line was actually found in
--   placement_cursors       how far the reader worker has read the sightings
--
-- Every table is created IF NOT EXISTS and every constraint is dropped before
-- it is added, so the file can be applied twice.

CREATE TABLE IF NOT EXISTS placement_room_map (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- A room (or a floor, or a department area) at the origin. Everything
  -- beneath it follows the mapping too, by matching names below each side.
  origin_location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  destination_location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_room_map_origin
  ON placement_room_map (job_id, origin_location_id);

CREATE TABLE IF NOT EXISTS placement_observations (
  id                    bigserial PRIMARY KEY,
  -- The job being worked when this was seen.
  job_id                uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- The line it is about; null for an item that is not on this job.
  job_item_id           uuid REFERENCES job_items(id) ON DELETE CASCADE,
  item_id               uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id               uuid REFERENCES item_units(id) ON DELETE CASCADE,
  -- What was scanned or read, when there was a code.
  code                  text,
  outcome               text NOT NULL,
  -- Where the plan sends it, and where it was found.
  expected_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  actual_location_id    uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- The shipment being unloaded, for a wrong-shipment scan.
  shipment_id           uuid REFERENCES shipments(id) ON DELETE SET NULL,
  -- The open job the item is on instead, for a wrong-job scan.
  other_job_id          uuid REFERENCES jobs(id) ON DELETE SET NULL,
  -- No foreign key, like sightings: a removed reader keeps its history.
  device_id             uuid,
  via                   text NOT NULL DEFAULT 'manual',
  user_oid              text,
  actor                 text,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE placement_observations DROP CONSTRAINT IF EXISTS placement_observations_outcome_check;
ALTER TABLE placement_observations ADD CONSTRAINT placement_observations_outcome_check
  CHECK (outcome IN ('placed', 'misplaced', 'wrong_shipment', 'wrong_job'));
ALTER TABLE placement_observations DROP CONSTRAINT IF EXISTS placement_observations_via_check;
ALTER TABLE placement_observations ADD CONSTRAINT placement_observations_via_check
  CHECK (via ~ '^[a-z][a-z0-9_]{0,31}$');
CREATE INDEX IF NOT EXISTS idx_placement_observations_job
  ON placement_observations (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_placement_observations_line
  ON placement_observations (job_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_placement_observations_actual
  ON placement_observations (actual_location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS placement_cursors (
  name        text PRIMARY KEY,
  last_id     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
