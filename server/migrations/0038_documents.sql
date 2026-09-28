-- Documents: templates built from blocks, reusable custom fields, packets of
-- templates that attach themselves to jobs, and the filled-in documents.
--
-- A template's body lives in document_template_versions. Editing a published
-- version creates a new version, and a filled document points at the version
-- it was started from, so later edits never change what someone filled in or
-- signed. A version's body is self-contained: field blocks carry their own
-- definitions, copied from document_custom_fields when inserted.
--
-- Packet conditions are jsonb, evaluated by the application (job type,
-- project, phase, site, rules on job fields), so new condition kinds need no
-- migration.
--
-- Every table is created IF NOT EXISTS and every constraint is dropped before it
-- is added, so the file can be applied twice.

CREATE TABLE IF NOT EXISTS document_custom_fields (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The key values are stored under in a document, and what {{field.key}}
  -- merges. Shared keys are what lets one document fill in from another.
  key          text NOT NULL,
  label        text NOT NULL,
  type         text NOT NULL,
  required     boolean NOT NULL DEFAULT false,
  -- Type-specific settings: select options, multiline, placeholder, help.
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE document_custom_fields DROP CONSTRAINT IF EXISTS document_custom_fields_key_check;
ALTER TABLE document_custom_fields ADD CONSTRAINT document_custom_fields_key_check
  CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$');
ALTER TABLE document_custom_fields DROP CONSTRAINT IF EXISTS document_custom_fields_type_check;
ALTER TABLE document_custom_fields ADD CONSTRAINT document_custom_fields_type_check
  CHECK (type IN ('text', 'number', 'date', 'checkbox', 'select', 'signature', 'initials'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_custom_fields_key ON document_custom_fields (key);

CREATE TABLE IF NOT EXISTS document_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  active       boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_templates_name ON document_templates (lower(name));

CREATE TABLE IF NOT EXISTS document_template_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  -- draft: still being edited, never used by a document.
  -- published: frozen; new documents start from the latest one.
  status        text NOT NULL DEFAULT 'draft',
  -- The document's title as printed, and its blocks:
  -- [{ "id", "type": "heading" | "paragraph" | "field" | "table" | "divider", ... }]
  title         text NOT NULL,
  body          jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at  timestamptz,
  published_by  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE document_template_versions DROP CONSTRAINT IF EXISTS document_template_versions_status_check;
ALTER TABLE document_template_versions ADD CONSTRAINT document_template_versions_status_check
  CHECK (status IN ('draft', 'published'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_versions
  ON document_template_versions (template_id, version);
-- At most one draft per template: the editor always works on that one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_versions_draft
  ON document_template_versions (template_id) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS document_packets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  -- { jobTypeIds, projectIds, phaseIds, siteLocationIds, siteSide, rules, ruleMatch }
  conditions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Attach to matching jobs on its own when a job is created or changed.
  auto_attach  boolean NOT NULL DEFAULT true,
  active       boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_packets_name ON document_packets (lower(name));

CREATE TABLE IF NOT EXISTS document_packet_templates (
  packet_id    uuid NOT NULL REFERENCES document_packets(id) ON DELETE CASCADE,
  template_id  uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  position     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (packet_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_document_packet_templates_template ON document_packet_templates (template_id);

-- Which packets a job has. Kept separately from the documents so a document
-- someone deleted on purpose is not recreated the next time the job changes.
CREATE TABLE IF NOT EXISTS document_job_packets (
  job_id       uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  packet_id    uuid NOT NULL REFERENCES document_packets(id) ON DELETE CASCADE,
  -- Attached by its conditions (true) or by hand (false). Only automatic ones
  -- are withdrawn when the job stops matching.
  auto         boolean NOT NULL DEFAULT true,
  -- False once an automatic packet stops matching but still has filled-in
  -- documents, which are kept.
  applies      boolean NOT NULL DEFAULT true,
  attached_by  text,
  attached_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, packet_id)
);
CREATE INDEX IF NOT EXISTS idx_document_job_packets_packet ON document_job_packets (packet_id);

CREATE TABLE IF NOT EXISTS documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          uuid NOT NULL REFERENCES document_templates(id) ON DELETE RESTRICT,
  template_version_id  uuid NOT NULL REFERENCES document_template_versions(id) ON DELETE RESTRICT,
  job_id               uuid REFERENCES jobs(id) ON DELETE CASCADE,
  packet_id            uuid REFERENCES document_packets(id) ON DELETE SET NULL,
  position             integer NOT NULL DEFAULT 0,
  title                text NOT NULL,
  -- draft: being filled in; completed: values fixed and hashed;
  -- signed: every required signature is on it.
  status               text NOT NULL DEFAULT 'draft',
  -- { fieldKey: value }. Signature and initials fields hold
  -- { signatureId, signerName, signedAt }.
  field_values         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Job data as it was when the document was completed, so merge fields and
  -- tables print what was agreed to rather than what the job says today.
  snapshot             jsonb,
  -- sha256 of the canonical content (template version, title, values without
  -- signatures, snapshot), fixed at completion.
  content_hash         text,
  copied_from          uuid REFERENCES documents(id) ON DELETE SET NULL,
  completed_at         timestamptz,
  completed_by         text,
  signed_at            timestamptz,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('draft', 'completed', 'signed'));
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_hash_check;
ALTER TABLE documents ADD CONSTRAINT documents_hash_check
  CHECK (status = 'draft' OR content_hash IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_documents_job ON documents (job_id, position);
CREATE INDEX IF NOT EXISTS idx_documents_template ON documents (template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status, updated_at DESC);

-- Every PDF exported from a completed or signed document, by the sha256 of
-- its bytes, so a copy that turns up later can be checked.
CREATE TABLE IF NOT EXISTS document_exports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sha256         text NOT NULL,
  content_hash   text NOT NULL,
  status         text NOT NULL,
  size_bytes     integer NOT NULL,
  attachment_id  uuid REFERENCES attachments(id) ON DELETE SET NULL,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_exports_sha ON document_exports (sha256);
CREATE INDEX IF NOT EXISTS idx_document_exports_document ON document_exports (document_id, created_at DESC);
