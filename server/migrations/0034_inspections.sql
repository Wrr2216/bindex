-- T13: pre- and post-move facility inspections.
--
-- A building is inventoried like anything else: a pre-move survey records the
-- condition of walls, doors, floors, dock doors and elevators before the crew
-- starts, a post-move survey records it afterwards, and the two are compared.
--
-- Photos and signatures live in T02's attachments and signatures tables, owned
-- by the inspection (owner_type 'inspection'). A finding lists the photos it
-- shows in attachment_ids rather than owning them, because the photo is taken
-- before the finding exists (the AI reads it first).

CREATE TABLE IF NOT EXISTS inspections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text NOT NULL,
  kind                   text NOT NULL,
  status                 text NOT NULL DEFAULT 'draft',
  -- An inspection is evidence about a building, so it outlives the job and
  -- the location record it was made for.
  job_id                 uuid REFERENCES jobs(id) ON DELETE SET NULL,
  job_task_id            uuid REFERENCES job_tasks(id) ON DELETE SET NULL,
  location_id            uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- The site as it was named when the inspection started, for the report and
  -- the signed content, which must not change when a location is renamed.
  site_name              text NOT NULL,
  -- A post-inspection is compared with this pre-inspection.
  pre_inspection_id      uuid REFERENCES inspections(id) ON DELETE SET NULL,
  inspectors             text[] NOT NULL DEFAULT '{}',
  notes                  text,
  -- The two sign-offs the report asks for. Plain ids rather than foreign keys:
  -- signatures are not in the JSON backup, and a restore must not fail on them.
  facility_signature_id  uuid,
  crew_signature_id      uuid,
  started_by             text,
  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  completed_by           text,
  signed_at              timestamptz,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_kind_check;
ALTER TABLE inspections ADD CONSTRAINT inspections_kind_check CHECK (kind IN ('pre', 'post', 'adhoc'));
ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_status_check;
ALTER TABLE inspections ADD CONSTRAINT inspections_status_check CHECK (status IN ('draft', 'completed', 'signed'));
-- Only a post-inspection is compared with anything.
ALTER TABLE inspections DROP CONSTRAINT IF EXISTS inspections_pre_check;
ALTER TABLE inspections ADD CONSTRAINT inspections_pre_check
  CHECK (pre_inspection_id IS NULL OR (kind = 'post' AND pre_inspection_id <> id));

CREATE UNIQUE INDEX IF NOT EXISTS inspections_code_key ON inspections (code);
CREATE INDEX IF NOT EXISTS idx_inspections_job ON inspections (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inspections_location ON inspections (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inspections_pre ON inspections (pre_inspection_id) WHERE pre_inspection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inspections_started ON inspections (started_at DESC);

CREATE TABLE IF NOT EXISTS inspection_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id   uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  sequence        integer NOT NULL DEFAULT 0,
  area            text NOT NULL DEFAULT 'inside',
  -- Free text, so a room with no location record can still be named. When
  -- location_id is set, room holds that location's path below the site.
  room            text NOT NULL,
  location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
  spot            text NOT NULL,
  spot_detail     text,
  description     text NOT NULL,
  severity        text NOT NULL DEFAULT 'minor',
  ai_generated    boolean NOT NULL DEFAULT false,
  -- What the model said before a person edited it, kept for review.
  ai_suggestion   jsonb,
  pre_existing    boolean NOT NULL DEFAULT false,
  attachment_ids  uuid[] NOT NULL DEFAULT '{}',
  -- On a post-inspection finding: the pre-inspection finding it was decided to
  -- be the same damage as, by AI or by a person. Pairs by room and spot are
  -- recomputed on every read and never stored.
  paired_with_id  uuid REFERENCES inspection_findings(id) ON DELETE SET NULL,
  pair_source     text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inspection_findings DROP CONSTRAINT IF EXISTS inspection_findings_area_check;
ALTER TABLE inspection_findings ADD CONSTRAINT inspection_findings_area_check CHECK (area IN ('inside', 'outside'));
ALTER TABLE inspection_findings DROP CONSTRAINT IF EXISTS inspection_findings_severity_check;
ALTER TABLE inspection_findings ADD CONSTRAINT inspection_findings_severity_check
  CHECK (severity IN ('minor', 'moderate', 'major'));
-- Spots are checked for shape only; the list is in services/inspections/model.ts,
-- so adding one (a "column", a "rack") needs no migration.
ALTER TABLE inspection_findings DROP CONSTRAINT IF EXISTS inspection_findings_spot_check;
ALTER TABLE inspection_findings ADD CONSTRAINT inspection_findings_spot_check CHECK (spot ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE inspection_findings DROP CONSTRAINT IF EXISTS inspection_findings_pair_check;
ALTER TABLE inspection_findings ADD CONSTRAINT inspection_findings_pair_check
  CHECK (pair_source IS NULL OR pair_source IN ('ai', 'manual'));

CREATE INDEX IF NOT EXISTS idx_inspection_findings_inspection ON inspection_findings (inspection_id, sequence);
CREATE INDEX IF NOT EXISTS idx_inspection_findings_paired ON inspection_findings (paired_with_id) WHERE paired_with_id IS NOT NULL;

-- Read-only links to a report for someone without an account. The token is
-- signed and carries its own expiry; the row is what lets a link be revoked
-- early and says how often it was opened.
CREATE TABLE IF NOT EXISTS inspection_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id   uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  last_opened_at  timestamptz,
  open_count      integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inspection_shares_inspection ON inspection_shares (inspection_id, created_at);
