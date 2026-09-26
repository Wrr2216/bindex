-- Operations insights: anomalies found by deterministic rules, the runs that
-- found them, and per-location facts the analytics need (distance to the dock,
-- site coordinates, vehicle capacity).
--
-- Nothing here references another feature's tables with a foreign key except
-- locations, and that one on purpose does not cascade into restores: see
-- ops_location_profiles below. Every statement can run twice.

-- ---------------------------------------------------------------------------
-- Anomalies
-- ---------------------------------------------------------------------------
-- One row per occurrence of a problem. (rule, key) identifies the problem
-- (the rule and the record it is about); at most one row per (rule, key) is
-- open at a time, and a problem that comes back after being fixed gets a new
-- row, so the history of each one survives.
--
-- item_id, job_id, shipment_id and location_id are for filtering and linking
-- only. They carry no foreign keys: an anomaly about something that was since
-- deleted is still a record of what was seen.
CREATE TABLE IF NOT EXISTS ops_anomalies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule              text NOT NULL,
  key               text NOT NULL,
  severity          text NOT NULL DEFAULT 'medium',
  subject_type      text NOT NULL,
  subject_id        text NOT NULL,
  item_id           uuid,
  unit_id           uuid,
  job_id            uuid,
  shipment_id       uuid,
  location_id       uuid,
  title             text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The screen where it gets fixed, as an app path such as /jobs/<id>.
  link              text,
  -- Sticky anomalies record an event (a tag in two places at once) and stay
  -- open until a person resolves them. The others record a condition and clear
  -- themselves when a run no longer finds it.
  sticky            boolean NOT NULL DEFAULT false,
  occurrences       integer NOT NULL DEFAULT 1,
  -- When the latest occurrence happened, for sticky anomalies.
  occurred_at       timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  -- For a dismissed anomaly: when the condition went away, after which the
  -- same problem is reported afresh.
  cleared_at        timestamptz,
  resolved_at       timestamptz,
  resolved_by       text,
  resolved_by_name  text,
  resolution        text,
  resolution_note   text,
  -- The row this one follows, when the same problem came back.
  reopened_from     uuid,
  explanation       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ops_anomalies DROP CONSTRAINT IF EXISTS ops_anomalies_rule_check;
ALTER TABLE ops_anomalies ADD CONSTRAINT ops_anomalies_rule_check
  CHECK (rule ~ '^[a-z][a-z0-9_]{0,47}$');
ALTER TABLE ops_anomalies DROP CONSTRAINT IF EXISTS ops_anomalies_severity_check;
ALTER TABLE ops_anomalies ADD CONSTRAINT ops_anomalies_severity_check
  CHECK (severity IN ('low', 'medium', 'high'));
ALTER TABLE ops_anomalies DROP CONSTRAINT IF EXISTS ops_anomalies_resolution_check;
ALTER TABLE ops_anomalies ADD CONSTRAINT ops_anomalies_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('fixed', 'dismissed', 'cleared'));
ALTER TABLE ops_anomalies DROP CONSTRAINT IF EXISTS ops_anomalies_resolved_check;
ALTER TABLE ops_anomalies ADD CONSTRAINT ops_anomalies_resolved_check
  CHECK ((resolved_at IS NULL) = (resolution IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_anomalies_open
  ON ops_anomalies (rule, key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ops_anomalies_rule_key
  ON ops_anomalies (rule, key, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_anomalies_open
  ON ops_anomalies (severity, first_seen_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ops_anomalies_first_seen
  ON ops_anomalies (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_anomalies_item
  ON ops_anomalies (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ops_anomalies_job
  ON ops_anomalies (job_id) WHERE job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
-- What each pass of the rules found, for the "last run" line and for spotting
-- a rule that keeps failing. Pruned to the most recent few hundred.
CREATE TABLE IF NOT EXISTS ops_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger      text NOT NULL DEFAULT 'schedule',
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  opened       integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  cleared      integer NOT NULL DEFAULT 0,
  -- { rule: { found, opened, cleared, ms, error? } }
  by_rule      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  user_oid     text
);
ALTER TABLE ops_runs DROP CONSTRAINT IF EXISTS ops_runs_trigger_check;
ALTER TABLE ops_runs ADD CONSTRAINT ops_runs_trigger_check
  CHECK (trigger IN ('schedule', 'manual'));
CREATE INDEX IF NOT EXISTS idx_ops_runs_started ON ops_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Location profiles
-- ---------------------------------------------------------------------------
-- Facts about a location that only operations insights use: how far it is
-- from the dock (slotting), where it is on the map (impossible travel), and,
-- for a location that is a truck or trailer, what it can carry (load
-- planning). One optional row per location.
--
-- location_id deliberately has no foreign key. A backup restore deletes and
-- re-inserts every location with the same ids; a cascading key would take the
-- profiles with it. Rows whose location is gone are ignored by every query and
-- removed by the scheduled run.
CREATE TABLE IF NOT EXISTS ops_location_profiles (
  location_id        uuid PRIMARY KEY,
  -- dock | pick | storage | staging | vehicle, or null for "not set".
  role               text,
  distance_to_dock_m double precision,
  lat                double precision,
  lng                double precision,
  max_kg             double precision,
  max_m3             double precision,
  interior_length_m  double precision,
  interior_width_m   double precision,
  interior_height_m  double precision,
  notes              text,
  updated_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ops_location_profiles DROP CONSTRAINT IF EXISTS ops_location_profiles_role_check;
ALTER TABLE ops_location_profiles ADD CONSTRAINT ops_location_profiles_role_check
  CHECK (role IS NULL OR role IN ('dock', 'pick', 'storage', 'staging', 'vehicle'));
ALTER TABLE ops_location_profiles DROP CONSTRAINT IF EXISTS ops_location_profiles_numbers_check;
ALTER TABLE ops_location_profiles ADD CONSTRAINT ops_location_profiles_numbers_check
  CHECK (
    (distance_to_dock_m IS NULL OR distance_to_dock_m >= 0)
    AND (lat IS NULL OR lat BETWEEN -90 AND 90)
    AND (lng IS NULL OR lng BETWEEN -180 AND 180)
    AND ((lat IS NULL) = (lng IS NULL))
    AND (max_kg IS NULL OR max_kg > 0)
    AND (max_m3 IS NULL OR max_m3 > 0)
    AND (interior_length_m IS NULL OR interior_length_m > 0)
    AND (interior_width_m IS NULL OR interior_width_m > 0)
    AND (interior_height_m IS NULL OR interior_height_m > 0)
  );

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- How identifiers are compared for "differs only by formatting": letters and
-- digits only, uppercased. Mirrors identityKey() in services/ops-intel/text.ts.
CREATE OR REPLACE FUNCTION ops_identity_key(v text) RETURNS text AS $$
  SELECT upper(regexp_replace(coalesce(v, ''), '[^0-9A-Za-z]', '', 'g'));
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Great-circle distance in metres. Mirrors haversineM() in
-- services/ops-intel/geo.ts; used only to narrow what the rule looks at.
CREATE OR REPLACE FUNCTION ops_haversine_m(lat1 double precision, lng1 double precision,
                                           lat2 double precision, lng2 double precision)
RETURNS double precision AS $$
  SELECT 2 * 6371008.8 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
