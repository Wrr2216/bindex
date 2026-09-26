-- Crew check-in and credentials.
--
-- A worker is a person who turns up on jobs: an employee, a temp, a
-- subcontractor's crew. Each carries a badge whose code (printed as a QR) is
-- scanned to check them in on a job. Credentials are what they hold that a job
-- may require: a background check, a forklift licence, a site induction. What
-- a job requires, and whether a missing or expired credential blocks the
-- check-in or only warns, is set per job type (job_types.settings.crew), so
-- nothing here touches the jobs tables beyond a foreign key.
--
-- Every table is created IF NOT EXISTS and every constraint is dropped before
-- it is added, so the file can be applied twice.

CREATE TABLE IF NOT EXISTS crew_credential_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identifier, used in job type requirements and by an external
  -- verifier to say which credential a status is about. Never changes.
  key              text NOT NULL,
  name             text NOT NULL,
  description      text,
  -- How long one usually lasts, to fill in the expiry from the issue date.
  validity_months  integer,
  -- A credential expiring within this many days shows amber.
  warn_days        integer NOT NULL DEFAULT 30,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE crew_credential_types DROP CONSTRAINT IF EXISTS crew_credential_types_key_check;
ALTER TABLE crew_credential_types ADD CONSTRAINT crew_credential_types_key_check
  CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE crew_credential_types DROP CONSTRAINT IF EXISTS crew_credential_types_validity_check;
ALTER TABLE crew_credential_types ADD CONSTRAINT crew_credential_types_validity_check
  CHECK (validity_months IS NULL OR validity_months BETWEEN 1 AND 600);
ALTER TABLE crew_credential_types DROP CONSTRAINT IF EXISTS crew_credential_types_warn_check;
ALTER TABLE crew_credential_types ADD CONSTRAINT crew_credential_types_warn_check
  CHECK (warn_days BETWEEN 0 AND 365);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_credential_types_key ON crew_credential_types (key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_credential_types_name ON crew_credential_types (lower(name));

-- A starting list; administrators rename, add and retire their own.
INSERT INTO crew_credential_types (key, name, description, validity_months, warn_days) VALUES
  ('background_check', 'Background check', 'Criminal record and identity screening.', 12, 30),
  ('forklift', 'Forklift licence', 'Powered industrial truck operator certification.', 36, 60),
  ('site_induction', 'Site induction', 'Safety briefing for the site or client premises.', 12, 14),
  ('osha_10', 'OSHA 10', 'OSHA 10-hour construction or general industry card.', NULL, 30),
  ('dot_medical', 'DOT medical card', 'Medical examiner''s certificate for commercial drivers.', 24, 30)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS crew_workers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  -- Employer or subcontractor, as free text: crews come from companies that
  -- are not otherwise in the inventory.
  company              text,
  role                 text,
  -- What the badge's QR carries. Generated (CRW-…) or set to an existing
  -- badge's number; compared without regard to case.
  badge_code           text NOT NULL,
  phone                text,
  -- An attachment (owner type crew_worker) printed on the badge. Not a
  -- foreign key: attachments are not in the JSON backup, and a restore onto a
  -- new instance should keep the worker and lose only the picture.
  photo_attachment_id  uuid,
  active               boolean NOT NULL DEFAULT true,
  notes                text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_workers_badge ON crew_workers (lower(badge_code));
CREATE INDEX IF NOT EXISTS idx_crew_workers_name ON crew_workers (lower(name));
CREATE INDEX IF NOT EXISTS idx_crew_workers_company ON crew_workers (lower(company));

CREATE TABLE IF NOT EXISTS crew_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    uuid NOT NULL REFERENCES crew_workers(id) ON DELETE CASCADE,
  -- A type with credentials on file cannot be deleted, only retired.
  type_id      uuid NOT NULL REFERENCES crew_credential_types(id) ON DELETE RESTRICT,
  issuer       text,
  number       text,
  issued_on    date,
  -- Null: does not expire.
  expires_on   date,
  status       text NOT NULL DEFAULT 'valid',
  -- manual: typed in by a person. verifier: written by CREDENTIAL_VERIFY_URL,
  -- one row per worker and type, refreshed on every check.
  source       text NOT NULL DEFAULT 'manual',
  verified_at  timestamptz,
  notes        text,
  created_by   text,
  updated_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE crew_credentials DROP CONSTRAINT IF EXISTS crew_credentials_status_check;
ALTER TABLE crew_credentials ADD CONSTRAINT crew_credentials_status_check
  CHECK (status IN ('valid', 'pending', 'expired', 'failed', 'suspended', 'revoked'));
ALTER TABLE crew_credentials DROP CONSTRAINT IF EXISTS crew_credentials_source_check;
ALTER TABLE crew_credentials ADD CONSTRAINT crew_credentials_source_check
  CHECK (source IN ('manual', 'verifier'));
ALTER TABLE crew_credentials DROP CONSTRAINT IF EXISTS crew_credentials_dates_check;
ALTER TABLE crew_credentials ADD CONSTRAINT crew_credentials_dates_check
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on);
CREATE INDEX IF NOT EXISTS idx_crew_credentials_worker ON crew_credentials (worker_id);
CREATE INDEX IF NOT EXISTS idx_crew_credentials_type ON crew_credentials (type_id);
CREATE INDEX IF NOT EXISTS idx_crew_credentials_expires ON crew_credentials (expires_on) WHERE expires_on IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_credentials_verifier
  ON crew_credentials (worker_id, type_id) WHERE source = 'verifier';

CREATE TABLE IF NOT EXISTS crew_checkins (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- Hours are payroll evidence: a worker with check-ins is retired, not deleted.
  worker_id            uuid NOT NULL REFERENCES crew_workers(id) ON DELETE RESTRICT,
  checked_in_at        timestamptz NOT NULL DEFAULT now(),
  checked_out_at       timestamptz,
  break_minutes        integer NOT NULL DEFAULT 0,
  via                  text NOT NULL DEFAULT 'manual',
  -- The compliance seen at the door, kept as it was: a credential renewed or
  -- revoked later does not rewrite what was known when they were let in.
  compliance           text NOT NULL,
  compliance_detail    jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy               text NOT NULL DEFAULT 'warn',
  override_reason      text,
  overridden_by        text,
  overridden_by_name   text,
  checked_in_by        text,
  checked_in_by_name   text,
  checked_out_by       text,
  checked_out_by_name  text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE crew_checkins DROP CONSTRAINT IF EXISTS crew_checkins_compliance_check;
ALTER TABLE crew_checkins ADD CONSTRAINT crew_checkins_compliance_check
  CHECK (compliance IN ('green', 'amber', 'red'));
ALTER TABLE crew_checkins DROP CONSTRAINT IF EXISTS crew_checkins_policy_check;
ALTER TABLE crew_checkins ADD CONSTRAINT crew_checkins_policy_check
  CHECK (policy IN ('warn', 'block'));
ALTER TABLE crew_checkins DROP CONSTRAINT IF EXISTS crew_checkins_via_check;
ALTER TABLE crew_checkins ADD CONSTRAINT crew_checkins_via_check
  CHECK (via ~ '^[a-z][a-z0-9_]{0,31}$');
ALTER TABLE crew_checkins DROP CONSTRAINT IF EXISTS crew_checkins_break_check;
ALTER TABLE crew_checkins ADD CONSTRAINT crew_checkins_break_check
  CHECK (break_minutes BETWEEN 0 AND 1440);
ALTER TABLE crew_checkins DROP CONSTRAINT IF EXISTS crew_checkins_times_check;
ALTER TABLE crew_checkins ADD CONSTRAINT crew_checkins_times_check
  CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at);
-- Nobody is on two jobs at once: at most one open check-in per worker.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_checkins_open ON crew_checkins (worker_id) WHERE checked_out_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crew_checkins_job ON crew_checkins (job_id, checked_in_at);
CREATE INDEX IF NOT EXISTS idx_crew_checkins_worker ON crew_checkins (worker_id, checked_in_at);
