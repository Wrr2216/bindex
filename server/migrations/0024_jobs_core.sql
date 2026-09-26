-- Projects, jobs, shipments and relocation manifests.
--
-- A project groups jobs into phases. A job moves a set of items (its manifest,
-- job_items) from where they are to where they are going, in one or more
-- shipments, through a fixed ladder of stages: pending, packed, loaded,
-- delivered, placed. Every stage change is kept in job_item_stage_history.
--
-- Stage names and task kinds are validated by the application, not by a CHECK
-- listing them, so a later feature can register its own (a "refused" exception
-- stage, an "inspection" task kind) without a migration that fights this one.
-- The database only insists they look like identifiers.
--
-- Every table is created IF NOT EXISTS and every constraint is dropped before it
-- is added, so the file can be applied twice.

CREATE TABLE IF NOT EXISTS job_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  color          text NOT NULL DEFAULT '#0284c7',
  description    text,
  -- [{ "kind": "pack", "title": "Pack" }, ...], copied into job_tasks when a
  -- job of this type is created.
  task_template  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Per-type configuration owned by later features (required credentials,
  -- document packets, ...), keyed by feature so they never collide.
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_types_name ON job_types (lower(name));

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  entity_id   uuid REFERENCES entities(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'planned',
  starts_on   date,
  ends_on     date,
  notes       text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_code ON projects (code);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);

CREATE TABLE IF NOT EXISTS project_phases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence    integer NOT NULL DEFAULT 0,
  name        text NOT NULL,
  -- The phase's window.
  starts_on   date,
  ends_on     date,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_phases_project ON project_phases (project_id, sequence);

CREATE TABLE IF NOT EXISTS jobs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text NOT NULL,
  project_id               uuid REFERENCES projects(id) ON DELETE SET NULL,
  phase_id                 uuid REFERENCES project_phases(id) ON DELETE SET NULL,
  job_type_id              uuid REFERENCES job_types(id) ON DELETE SET NULL,
  name                     text NOT NULL,
  status                   text NOT NULL DEFAULT 'planned',
  origin_location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
  destination_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  scheduled_start          timestamptz,
  scheduled_end            timestamptz,
  started_at               timestamptz,
  completed_at             timestamptz,
  notes                    text,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_code ON jobs (code);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs (project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS job_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence            integer NOT NULL DEFAULT 0,
  kind                text NOT NULL DEFAULT 'custom',
  title               text NOT NULL,
  status              text NOT NULL DEFAULT 'todo',
  assignee_entity_id  uuid REFERENCES entities(id) ON DELETE SET NULL,
  assignee_user_oid   text,
  due_at              timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  completed_by        text,
  notes               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job_tasks DROP CONSTRAINT IF EXISTS job_tasks_status_check;
ALTER TABLE job_tasks ADD CONSTRAINT job_tasks_status_check
  CHECK (status IN ('todo', 'doing', 'done', 'skipped'));
ALTER TABLE job_tasks DROP CONSTRAINT IF EXISTS job_tasks_kind_check;
ALTER TABLE job_tasks ADD CONSTRAINT job_tasks_kind_check
  CHECK (kind ~ '^[a-z][a-z0-9_]{0,39}$');
CREATE INDEX IF NOT EXISTS idx_job_tasks_job ON job_tasks (job_id, sequence);

CREATE TABLE IF NOT EXISTS shipments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL,
  job_id               uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  status               text NOT NULL DEFAULT 'planned',
  -- A location that is a truck or trailer, so what is on it can be audited
  -- like any other place.
  vehicle_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  carrier              text,
  seal_numbers         text[] NOT NULL DEFAULT '{}',
  weight_kg            double precision,
  volume_m3            double precision,
  distance_km          double precision,
  eta                  timestamptz,
  departed_at          timestamptz,
  arrived_at           timestamptz,
  notes                text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_status_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check
  CHECK (status IN ('planned', 'staged', 'loaded', 'in_transit', 'delivered', 'closed'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_code ON shipments (code);
CREATE INDEX IF NOT EXISTS idx_shipments_job ON shipments (job_id);

-- A shipment's status changes, with the reason when one was forced past lines
-- that were not ready. Milestones for timelines and notifications.
CREATE TABLE IF NOT EXISTS shipment_status_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id  uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  forced       boolean NOT NULL DEFAULT false,
  reason       text,
  user_oid     text,
  actor        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipment_status_history_shipment
  ON shipment_status_history (shipment_id, created_at);

-- Manifest lines: one per item (or per tracked unit) on a job.
CREATE TABLE IF NOT EXISTS job_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  shipment_id              uuid REFERENCES shipments(id) ON DELETE SET NULL,
  item_id                  uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id                  uuid REFERENCES item_units(id) ON DELETE CASCADE,
  -- Where it was when it was added, kept even after the item moves.
  origin_location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
  destination_location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- Desk, room or bay as written on the move plan, when there is no location
  -- record for it (or as well as one).
  destination_label        text,
  floor                    text,
  department               text,
  crate_no                 text,
  stage                    text NOT NULL DEFAULT 'pending',
  stage_at                 timestamptz NOT NULL DEFAULT now(),
  stage_by                 text,
  notes                    text,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job_items DROP CONSTRAINT IF EXISTS job_items_stage_check;
ALTER TABLE job_items ADD CONSTRAINT job_items_stage_check
  CHECK (stage ~ '^[a-z][a-z0-9_]{0,31}$');
-- Once per job: the whole item, or each unit of it. The coalesce makes a NULL
-- unit compare equal to another NULL unit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_items_line
  ON job_items (job_id, item_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_job_items_job_stage ON job_items (job_id, stage);
CREATE INDEX IF NOT EXISTS idx_job_items_shipment ON job_items (shipment_id);
CREATE INDEX IF NOT EXISTS idx_job_items_item ON job_items (item_id);

CREATE TABLE IF NOT EXISTS job_item_stage_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_item_id  uuid NOT NULL REFERENCES job_items(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL,
  unit_id      uuid,
  shipment_id  uuid,
  from_stage   text,
  to_stage     text NOT NULL,
  -- How the change was made: scan, rfid, manual, api, or a later feature's own.
  via          text NOT NULL DEFAULT 'manual',
  device_id    text,
  user_oid     text,
  -- Display name of whoever made the change: a person, or an external party
  -- that has no account.
  actor        text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job_item_stage_history DROP CONSTRAINT IF EXISTS job_item_stage_history_via_check;
ALTER TABLE job_item_stage_history ADD CONSTRAINT job_item_stage_history_via_check
  CHECK (via ~ '^[a-z][a-z0-9_]{0,31}$');
CREATE INDEX IF NOT EXISTS idx_job_item_stage_history_line
  ON job_item_stage_history (job_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_item_stage_history_job
  ON job_item_stage_history (job_id, created_at DESC);

-- Two starting job types, so the first job can be created without a trip to
-- settings. Only added when missing, and editable or removable afterwards.
INSERT INTO job_types (name, color, description, task_template)
SELECT 'Relocation', '#0284c7',
       'Move a floor, department or site: inspect, pack, load, deliver, place, inspect.',
       '[{"kind":"pre_inspection","title":"Pre-move inspection"},
         {"kind":"pack","title":"Pack and tag"},
         {"kind":"load","title":"Load"},
         {"kind":"transit","title":"Transit"},
         {"kind":"unload","title":"Unload"},
         {"kind":"place","title":"Place at destination"},
         {"kind":"post_inspection","title":"Post-move inspection"}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM job_types WHERE lower(name) = 'relocation');

INSERT INTO job_types (name, color, description, task_template)
SELECT 'Delivery', '#059669',
       'Take items from stock to a site.',
       '[{"kind":"load","title":"Load"},
         {"kind":"transit","title":"Transit"},
         {"kind":"unload","title":"Unload"},
         {"kind":"place","title":"Place"}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM job_types WHERE lower(name) = 'delivery');
