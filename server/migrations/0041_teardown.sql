-- T20: teardown guides. A narrated teardown video of an item or unit becomes
-- numbered steps, each tied to the moment in the video it came from, and a list
-- of the parts that came off, for putting the thing back together.
--
-- A guide points at its item, unit and video without foreign keys. A JSON
-- restore deletes and re-inserts every item in one transaction; a cascade would
-- take the guides with it. Guides of deleted items are removed by the teardown
-- worker's sweep instead, the way attachments are (see services/teardown).

CREATE TABLE IF NOT EXISTS teardown_guides (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id              uuid NOT NULL,
  unit_id              uuid,
  title                text NOT NULL,
  notes                text,
  -- The narrated video (or audio), an attachment of the item or unit.
  video_attachment_id  uuid,
  duration_sec         double precision,
  -- { text, segments: [{ start, end, text }], complete, chunksDone, ... }
  transcript           jsonb,
  -- Steps and parts read from the narration, before they are applied. Held
  -- here while in progress (so a restart resumes) and while waiting for a
  -- person to accept them over steps they already wrote.
  draft                jsonb,
  refined_at           timestamptz,
  job_status           text NOT NULL DEFAULT 'idle',
  job_stage            text,
  job_progress         jsonb,
  job_error            text,
  job_notes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  job_attempts         integer NOT NULL DEFAULT 0,
  -- Whoever holds the job writes with this; a stale holder's writes miss.
  job_token            uuid,
  job_queued_at        timestamptz,
  job_started_at       timestamptz,
  job_heartbeat_at     timestamptz,
  job_finished_at      timestamptz,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE teardown_guides DROP CONSTRAINT IF EXISTS teardown_guides_job_status_check;
ALTER TABLE teardown_guides ADD CONSTRAINT teardown_guides_job_status_check
  CHECK (job_status IN ('idle', 'queued', 'running', 'done', 'failed'));

CREATE INDEX IF NOT EXISTS idx_teardown_guides_item ON teardown_guides (item_id, created_at);
-- The worker's claim query looks only at waiting and running guides.
CREATE INDEX IF NOT EXISTS idx_teardown_guides_job ON teardown_guides (job_queued_at)
  WHERE job_status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS teardown_steps (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id                uuid NOT NULL REFERENCES teardown_guides(id) ON DELETE CASCADE,
  -- Order within the guide. Step numbers are derived from it, so moving a
  -- step never leaves a gap.
  position                integer NOT NULL,
  title                   text NOT NULL,
  instruction             text NOT NULL DEFAULT '',
  start_sec               double precision,
  end_sec                 double precision,
  callout                 text,
  keyframe_attachment_id  uuid,
  -- narration: read from the video; manual: written by a person.
  source                  text NOT NULL DEFAULT 'manual',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_teardown_steps_guide ON teardown_steps (guide_id, position);

CREATE TABLE IF NOT EXISTS teardown_parts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id        uuid NOT NULL REFERENCES teardown_guides(id) ON DELETE CASCADE,
  -- The step it came off in. A deleted step leaves its parts on the list.
  step_id         uuid REFERENCES teardown_steps(id) ON DELETE SET NULL,
  position        integer NOT NULL DEFAULT 0,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'other',
  qty             integer NOT NULL DEFAULT 1,
  note            text,
  source          text NOT NULL DEFAULT 'manual',
  -- The name as heard, when a photo let the vision model name it better.
  heard_as        text,
  -- A person changed it, so later AI passes leave it alone.
  edited          boolean NOT NULL DEFAULT false,
  reassembled_at  timestamptz,
  reassembled_by  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE teardown_parts DROP CONSTRAINT IF EXISTS teardown_parts_kind_check;
ALTER TABLE teardown_parts ADD CONSTRAINT teardown_parts_kind_check
  CHECK (kind IN ('hardware', 'component', 'cable', 'other'));
ALTER TABLE teardown_parts DROP CONSTRAINT IF EXISTS teardown_parts_qty_check;
ALTER TABLE teardown_parts ADD CONSTRAINT teardown_parts_qty_check
  CHECK (qty BETWEEN 1 AND 100000);

CREATE INDEX IF NOT EXISTS idx_teardown_parts_guide ON teardown_parts (guide_id, position);
CREATE INDEX IF NOT EXISTS idx_teardown_parts_step ON teardown_parts (step_id);
