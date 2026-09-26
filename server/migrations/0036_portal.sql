-- External portal: links that let people without an account follow a
-- project, job or shipment (viewers) or work on one (contributors, such as a
-- subcontracted crew).
--
-- A grant is one link. Its token is shown once and stored only as a sha256
-- hash; a grant with no hash (restored from a backup) has no working link
-- until it is reissued. Every portal request re-reads the grant, so revoking
-- or expiring it takes effect on the next request.
--
-- Every table is created IF NOT EXISTS and every constraint is dropped before
-- it is added, so the file can be applied twice.

CREATE TABLE IF NOT EXISTS portal_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL,
  -- Exactly one of these is set, matching scope. Deleting the record deletes
  -- its links: a link to something that no longer exists must not linger.
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  job_id          uuid REFERENCES jobs(id) ON DELETE CASCADE,
  shipment_id     uuid REFERENCES shipments(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'viewer',
  grantee_name    text NOT NULL,
  grantee_email   text,
  grantee_org     text,
  -- What the link may see beyond the manifest itself.
  show_values     boolean NOT NULL DEFAULT false,
  show_documents  boolean NOT NULL DEFAULT true,
  -- Stages a contributor may scan lines to; null means the default set.
  allowed_stages  text[],
  -- Ask for a code sent to grantee_email before the link works in a browser.
  require_code    boolean NOT NULL DEFAULT false,
  -- Milestone emails to grantee_email.
  notify          boolean NOT NULL DEFAULT false,
  token_hash      text,
  token_last4     text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      text,
  last_used_at    timestamptz,
  use_count       integer NOT NULL DEFAULT 0,
  -- For staff only; never shown through the portal.
  note            text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_grants DROP CONSTRAINT IF EXISTS portal_grants_scope_check;
ALTER TABLE portal_grants ADD CONSTRAINT portal_grants_scope_check
  CHECK (scope IN ('project', 'job', 'shipment'));
ALTER TABLE portal_grants DROP CONSTRAINT IF EXISTS portal_grants_role_check;
ALTER TABLE portal_grants ADD CONSTRAINT portal_grants_role_check
  CHECK (role IN ('viewer', 'contributor'));
ALTER TABLE portal_grants DROP CONSTRAINT IF EXISTS portal_grants_target_check;
ALTER TABLE portal_grants ADD CONSTRAINT portal_grants_target_check CHECK (
  (scope = 'project' AND project_id IS NOT NULL AND job_id IS NULL AND shipment_id IS NULL)
  OR (scope = 'job' AND job_id IS NOT NULL AND project_id IS NULL AND shipment_id IS NULL)
  OR (scope = 'shipment' AND shipment_id IS NOT NULL AND project_id IS NULL AND job_id IS NULL)
);
-- A crew works one job or one shipment; a project is too wide to hand over.
ALTER TABLE portal_grants DROP CONSTRAINT IF EXISTS portal_grants_contributor_check;
ALTER TABLE portal_grants ADD CONSTRAINT portal_grants_contributor_check
  CHECK (role = 'viewer' OR scope IN ('job', 'shipment'));
ALTER TABLE portal_grants DROP CONSTRAINT IF EXISTS portal_grants_code_check;
ALTER TABLE portal_grants ADD CONSTRAINT portal_grants_code_check
  CHECK (NOT require_code OR grantee_email IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_grants_token ON portal_grants (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_grants_project ON portal_grants (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_grants_job ON portal_grants (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_grants_shipment ON portal_grants (shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_portal_grants_created ON portal_grants (created_at DESC);

-- The one outstanding emailed code per grant, hashed, with its attempts.
CREATE TABLE IF NOT EXISTS portal_codes (
  grant_id    uuid PRIMARY KEY REFERENCES portal_grants(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A browser that has entered the emailed code. Hashed like the token.
CREATE TABLE IF NOT EXISTS portal_passes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id      uuid NOT NULL REFERENCES portal_grants(id) ON DELETE CASCADE,
  pass_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_passes_hash ON portal_passes (pass_hash);
CREATE INDEX IF NOT EXISTS idx_portal_passes_grant ON portal_passes (grant_id);

-- Condition notes a contributor left on a manifest line. The grant is kept
-- by id and the author by name, so the note survives the link.
CREATE TABLE IF NOT EXISTS portal_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id     uuid REFERENCES portal_grants(id) ON DELETE SET NULL,
  author       text NOT NULL,
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_item_id  uuid NOT NULL REFERENCES job_items(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id      uuid REFERENCES item_units(id) ON DELETE SET NULL,
  condition    text,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_notes DROP CONSTRAINT IF EXISTS portal_notes_condition_check;
ALTER TABLE portal_notes ADD CONSTRAINT portal_notes_condition_check
  CHECK (condition IS NULL OR condition IN ('good', 'fair', 'poor', 'damaged'));
CREATE INDEX IF NOT EXISTS idx_portal_notes_line ON portal_notes (job_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_portal_notes_job ON portal_notes (job_id, created_at);

-- Milestone emails: one row per grant and milestone, which is what stops a
-- shipment bouncing between statuses from emailing twice. Rows wait as
-- pending until the grant's throttle window has passed, then go out together.
CREATE TABLE IF NOT EXISTS portal_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id       uuid NOT NULL REFERENCES portal_grants(id) ON DELETE CASCADE,
  milestone_key  text NOT NULL,
  title          text NOT NULL,
  event_id       bigint,
  occurred_at    timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  attempts       integer NOT NULL DEFAULT 0,
  sent_at        timestamptz,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_notifications DROP CONSTRAINT IF EXISTS portal_notifications_status_check;
ALTER TABLE portal_notifications ADD CONSTRAINT portal_notifications_status_check
  CHECK (status IN ('pending', 'sent', 'skipped', 'failed'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_notifications_milestone ON portal_notifications (grant_id, milestone_key);
CREATE INDEX IF NOT EXISTS idx_portal_notifications_pending ON portal_notifications (grant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_portal_notifications_sent ON portal_notifications (grant_id, sent_at DESC) WHERE status = 'sent';

-- How far the notifier has read the audit log. One row, locked while a
-- replica works, so two replicas never read the same events.
CREATE TABLE IF NOT EXISTS portal_notifier_state (
  id             smallint PRIMARY KEY DEFAULT 1,
  last_event_id  bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portal_notifier_state DROP CONSTRAINT IF EXISTS portal_notifier_state_single;
ALTER TABLE portal_notifier_state ADD CONSTRAINT portal_notifier_state_single CHECK (id = 1);
