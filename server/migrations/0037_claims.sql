-- Claims and incidents.
--
-- A claim asks for money back for something lost, damaged or delayed; an
-- incident report records something that went wrong without money involved
-- (a near miss, damage to a site, equipment that failed). Both live in
-- `claims`, told apart by type = 'incident', so they share one list, one
-- workflow and one evidence pack.
--
-- claim_lines are the items (or tracked units) a claim is about. Each keeps a
-- snapshot of the item's name, code and declared value, because a claim is a
-- record that has to stay readable after the item it names is deleted.
--
-- For the same reason the job, shipment, manifest line, item and unit a claim
-- points at are kept as plain ids rather than foreign keys: deleting a job
-- must not quietly cut a claim loose from the trip it is about. Their stage
-- changes stay in the audit log, which the evidence pack falls back on.
--
-- claim_activity is the claim's own history: comments, status changes with
-- their notes, assignments, line edits and exports. Each row points at the
-- audit-log entry it was published as, once there is one.
--
-- Nothing here references the condition, custody or portal tables of other
-- features: those are read at runtime when they exist, so this migration does
-- not depend on them being applied.
--
-- Every table is created IF NOT EXISTS and every constraint is dropped before
-- it is added, so the file can be applied twice.

CREATE TABLE IF NOT EXISTS claims (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CLM-7F3K2A for a claim, INC-7F3K2A for an incident report.
  code                   text NOT NULL,
  type                   text NOT NULL,
  -- For incidents: near_miss, site_damage, equipment_failure, ...
  category               text,
  status                 text NOT NULL DEFAULT 'draft',
  title                  text NOT NULL,
  description            text,
  job_id                 uuid,
  shipment_id            uuid,
  -- Where it happened, for site damage and incidents.
  location_id            uuid REFERENCES locations(id) ON DELETE SET NULL,
  occurred_at            timestamptz,
  -- Who reported it: a signed-in account, or an external party through a
  -- portal grant (no foreign key, so this does not depend on the portal).
  reporter_user_oid      text,
  reporter_grant_id      uuid,
  reporter_name          text,
  reporter_email         text,
  -- The reviewer.
  assignee_user_oid      text,
  assignee_name          text,
  assigned_at            timestamptz,
  -- The instance currency when the claim was opened, so amounts keep their
  -- meaning if the setting changes later.
  currency               text NOT NULL DEFAULT 'USD',
  -- Sums of the lines when there are lines; entered by hand when there are
  -- none (a delay claim).
  estimated_total_cents  bigint,
  approved_total_cents   bigint,
  paid_total_cents       bigint,
  carrier_reference      text,
  insurer_reference      text,
  payment_reference      text,
  submitted_at           timestamptz,
  decided_at             timestamptz,
  paid_at                timestamptz,
  closed_at              timestamptz,
  -- When a decision is due. Set on submission from the SLA for the type.
  sla_due_at             timestamptz,
  -- Stamped once, by the SLA watcher, when a claim goes past sla_due_at
  -- undecided, so the breach is announced exactly once.
  sla_breached_at        timestamptz,
  -- Fingerprint of the evidence pack as it stood on submission.
  evidence_hash          text,
  evidence_frozen_at     timestamptz,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_type_check;
ALTER TABLE claims ADD CONSTRAINT claims_type_check
  CHECK (type IN ('loss', 'damage', 'property_damage', 'delay', 'other', 'incident'));
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_status_check;
ALTER TABLE claims ADD CONSTRAINT claims_status_check
  CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'denied', 'paid', 'closed'));
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_category_check;
ALTER TABLE claims ADD CONSTRAINT claims_category_check
  CHECK (category IS NULL OR category ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_amounts_check;
ALTER TABLE claims ADD CONSTRAINT claims_amounts_check
  CHECK (coalesce(estimated_total_cents, 0) >= 0
     AND coalesce(approved_total_cents, 0) >= 0
     AND coalesce(paid_total_cents, 0) >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_code ON claims (code);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_job ON claims (job_id);
CREATE INDEX IF NOT EXISTS idx_claims_shipment ON claims (shipment_id);
CREATE INDEX IF NOT EXISTS idx_claims_assignee ON claims (assignee_user_oid);
CREATE INDEX IF NOT EXISTS idx_claims_grant ON claims (reporter_grant_id) WHERE reporter_grant_id IS NOT NULL;
-- What the SLA watcher scans: open claims whose breach has not been announced.
CREATE INDEX IF NOT EXISTS idx_claims_sla_open ON claims (sla_due_at)
  WHERE sla_breached_at IS NULL AND status IN ('submitted', 'under_review');

CREATE TABLE IF NOT EXISTS claim_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  position              integer NOT NULL DEFAULT 0,
  -- The manifest line it travelled on, when there is one, and that line's
  -- job: its stage history is the line's trip.
  job_item_id           uuid,
  job_id                uuid,
  item_id               uuid,
  unit_id               uuid,
  item_name             text,
  asset_code            text,
  declared_value_cents  bigint,
  description           text,
  damage_description    text,
  estimated_cents       bigint,
  approved_cents        bigint,
  resolution            text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE claim_lines DROP CONSTRAINT IF EXISTS claim_lines_resolution_check;
ALTER TABLE claim_lines ADD CONSTRAINT claim_lines_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('repair', 'replace', 'cash', 'deny'));
ALTER TABLE claim_lines DROP CONSTRAINT IF EXISTS claim_lines_amounts_check;
ALTER TABLE claim_lines ADD CONSTRAINT claim_lines_amounts_check
  CHECK (coalesce(estimated_cents, 0) >= 0
     AND coalesce(approved_cents, 0) >= 0
     AND coalesce(declared_value_cents, 0) >= 0);
CREATE INDEX IF NOT EXISTS idx_claim_lines_claim ON claim_lines (claim_id, position);
CREATE INDEX IF NOT EXISTS idx_claim_lines_item ON claim_lines (item_id);
CREATE INDEX IF NOT EXISTS idx_claim_lines_job_item ON claim_lines (job_item_id);
-- An item (or one unit of it) is on a claim once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_lines_item ON claim_lines
  (claim_id, item_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS claim_activity (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id         uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  from_status      text,
  to_status        text,
  body             text,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  author_user_oid  text,
  author_name      text,
  author_grant_id  uuid,
  -- The audit-log entry this was published as. Set just after, since events
  -- are published once the change has committed.
  audit_log_id     bigint,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE claim_activity DROP CONSTRAINT IF EXISTS claim_activity_kind_check;
ALTER TABLE claim_activity ADD CONSTRAINT claim_activity_kind_check
  CHECK (kind IN ('created', 'comment', 'status', 'assignment', 'lines', 'update', 'export', 'sla'));
CREATE INDEX IF NOT EXISTS idx_claim_activity_claim ON claim_activity (claim_id, created_at);
