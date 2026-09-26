-- T21: AI bulk capture. A capture session is one walkthrough of a room or
-- floor, one desk survey, or one paper inventory being converted. Its images
-- (photos, frames sampled from a video, pages rendered from a PDF) are sources;
-- what the vision model saw in them is merged into draft entries that a person
-- reviews before any item exists.
--
-- Sessions persist so a long walkthrough survives a refresh or a dropped
-- connection. The image files themselves are attachments owned by the session
-- (owner_type 'capture_session'), stored like every other attachment.

CREATE TABLE IF NOT EXISTS capture_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode          text NOT NULL,
  title         text NOT NULL,
  -- The room, floor or office being captured. Created items land here, or in
  -- a child location named after the photo's area (room or desk).
  location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'open',
  -- How counts of the same thing combine across photos: 'max' when photos
  -- overlap (the same chairs seen twice), 'sum' when they do not.
  count_rule    text NOT NULL DEFAULT 'max',
  -- Cost guard: the most images this session may send to the vision model.
  image_cap     integer NOT NULL DEFAULT 40,
  vision_calls  integer NOT NULL DEFAULT 0,
  -- Desk mode: the template in force, copied in so later edits to the
  -- instance's templates do not change a survey already under way.
  desk_template jsonb,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz,
  committed_by  text
);

ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_mode_check;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_mode_check
  CHECK (mode IN ('walkthrough', 'desk', 'manifest'));
ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_status_check;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_status_check
  CHECK (status IN ('open', 'committed'));
ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_count_rule_check;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_count_rule_check
  CHECK (count_rule IN ('max', 'sum'));
ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_image_cap_check;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_image_cap_check
  CHECK (image_cap BETWEEN 1 AND 1000 AND vision_calls >= 0);

CREATE INDEX IF NOT EXISTS idx_capture_sessions_created ON capture_sessions (created_at DESC);

-- One row per image the model reads. A video or PDF upload becomes several
-- rows, each pointing at its own frame or page image and back at the upload.
CREATE TABLE IF NOT EXISTS capture_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  attachment_id         uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  origin_attachment_id  uuid REFERENCES attachments(id) ON DELETE SET NULL,
  kind                  text NOT NULL,
  position              integer NOT NULL,
  frame_ms              integer,
  page_no               integer,
  -- The room of a floor walkthrough, the desk of a desk survey. Drafts only
  -- merge within one area.
  area                  text,
  status                text NOT NULL DEFAULT 'pending',
  -- The normalized reading, kept so a changed area can be re-merged without
  -- paying for another vision call.
  result                jsonb,
  error                 text,
  claimed_at            timestamptz,
  analysed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE capture_sources DROP CONSTRAINT IF EXISTS capture_sources_kind_check;
ALTER TABLE capture_sources ADD CONSTRAINT capture_sources_kind_check
  CHECK (kind IN ('photo', 'video_frame', 'pdf_page'));
ALTER TABLE capture_sources DROP CONSTRAINT IF EXISTS capture_sources_status_check;
ALTER TABLE capture_sources ADD CONSTRAINT capture_sources_status_check
  CHECK (status IN ('pending', 'analysing', 'analysed', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_capture_sources_attachment ON capture_sources (session_id, attachment_id);
CREATE INDEX IF NOT EXISTS idx_capture_sources_session ON capture_sources (session_id, position);

-- The reviewable list. Nothing becomes an item until a person commits it.
CREATE TABLE IF NOT EXISTS capture_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  -- 'discarded' rows are kept so a later photo of the same thing does not
  -- bring back an entry the person deleted.
  status            text NOT NULL DEFAULT 'pending',
  name              text NOT NULL,
  category          text,
  brand             text,
  model             text,
  description       text,
  qty               integer NOT NULL DEFAULT 1,
  -- Set once a person types a quantity, so later photos stop changing it.
  qty_locked        boolean NOT NULL DEFAULT false,
  -- Set once a person edits any field, so later photos only add evidence.
  edited            boolean NOT NULL DEFAULT false,
  manual            boolean NOT NULL DEFAULT false,
  area              text,
  location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- Paper manifests.
  line_no           integer,
  condition         text,
  condition_codes   text[] NOT NULL DEFAULT '{}',
  sticker_color     text,
  sticker_lot       text,
  sticker_number    text,
  confidence        real,
  -- [{ sourceId, attachmentId, name, qty, bbox, confidence }]: which images
  -- this entry was seen in, and what each one said.
  sources           jsonb NOT NULL DEFAULT '[]'::jsonb,
  note              text,
  created_item_ids  uuid[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE capture_drafts DROP CONSTRAINT IF EXISTS capture_drafts_status_check;
ALTER TABLE capture_drafts ADD CONSTRAINT capture_drafts_status_check
  CHECK (status IN ('pending', 'discarded', 'created'));
ALTER TABLE capture_drafts DROP CONSTRAINT IF EXISTS capture_drafts_qty_check;
ALTER TABLE capture_drafts ADD CONSTRAINT capture_drafts_qty_check
  CHECK (qty BETWEEN 1 AND 100000);

CREATE INDEX IF NOT EXISTS idx_capture_drafts_session ON capture_drafts (session_id, position);
