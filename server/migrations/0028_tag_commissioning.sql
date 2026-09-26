-- Tag commissioning: NFC tag UIDs and legacy sticker numbers as identifiers,
-- EPCs assigned for RFID printer-encoders, tags bound to individual units, and
-- bulk binding sessions.

-- Identifier types. The constraint has been rewritten three times, and every
-- type it has ever allowed stays valid: 0001 allowed upc, serial, asset_tag,
-- mac, sku and other; 0007 added rfid; 0012_domains added domain. This adds
-- nfc (a tag's UID) and legacy (a colour, lot and number sticker).
ALTER TABLE item_identifiers DROP CONSTRAINT IF EXISTS item_identifiers_type_check;
ALTER TABLE item_identifiers ADD CONSTRAINT item_identifiers_type_check
  CHECK (type IN ('upc','serial','asset_tag','mac','sku','other','rfid','domain','nfc','legacy'));

-- 0017 made identity-bearing codes unique across items. A tag UID and a
-- sticker number each name one physical thing, so they join that set. The
-- index keeps its name because the services match unique violations on it.
DROP INDEX IF EXISTS uq_item_identifiers_identity_value;
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_identifiers_identity_value
  ON item_identifiers (value)
  WHERE type IN ('serial', 'asset_tag', 'mac', 'rfid', 'nfc', 'legacy');

-- Readers report the same UID as "04:a2:3b:..." or "04A23B...". Comparing on
-- the letters and digits alone finds a tag however it was typed when bound.
CREATE INDEX IF NOT EXISTS idx_item_identifiers_tag_key
  ON item_identifiers ((upper(regexp_replace(value, '[^0-9A-Za-z]', '', 'g'))))
  WHERE type IN ('rfid', 'nfc');

-- A tag stuck on one unit of a multi-quantity item. The identifier row still
-- belongs to the item, so every existing lookup keeps working; this only adds
-- which unit it is on.
CREATE TABLE IF NOT EXISTS tag_identifier_units (
  identifier_id uuid PRIMARY KEY REFERENCES item_identifiers(id) ON DELETE CASCADE,
  unit_id       uuid NOT NULL REFERENCES item_units(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tag_identifier_units_unit ON tag_identifier_units (unit_id);

-- Structured view of each legacy sticker (RED-1234-56 as red, lot 1234, number
-- 56). Maintained by the trigger below rather than by application code, so a
-- sticker added through any path, a backup restore included, gets one.
CREATE TABLE IF NOT EXISTS tag_legacy_stickers (
  identifier_id uuid PRIMARY KEY REFERENCES item_identifiers(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  color         text NOT NULL,
  lot           text,
  number        bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_legacy_stickers_item ON tag_legacy_stickers (item_id);
CREATE INDEX IF NOT EXISTS idx_tag_legacy_stickers_series ON tag_legacy_stickers (color, lot, number);

CREATE OR REPLACE FUNCTION tag_sync_legacy_sticker() RETURNS trigger AS $$
DECLARE
  parts text[];
  n     int;
BEGIN
  IF NEW.type <> 'legacy' THEN
    DELETE FROM tag_legacy_stickers WHERE identifier_id = NEW.id;
    RETURN NEW;
  END IF;
  -- The application stores COLOR-LOT-NUMBER or COLOR-NUMBER. Anything else
  -- was written around it; keep the identifier and skip the structure.
  parts := string_to_array(NEW.value, '-');
  n := coalesce(array_length(parts, 1), 0);
  IF n NOT IN (2, 3)
     OR parts[1] !~ '^[A-Z]+$'
     OR parts[n] !~ '^[0-9]{1,15}$'
     OR (n = 3 AND parts[2] !~ '^[A-Z0-9]+$') THEN
    DELETE FROM tag_legacy_stickers WHERE identifier_id = NEW.id;
    RETURN NEW;
  END IF;
  INSERT INTO tag_legacy_stickers (identifier_id, item_id, color, lot, number)
  VALUES (NEW.id, NEW.item_id, parts[1], CASE WHEN n = 3 THEN parts[2] END, parts[n]::bigint)
  ON CONFLICT (identifier_id) DO UPDATE
    SET item_id = EXCLUDED.item_id,
        color   = EXCLUDED.color,
        lot     = EXCLUDED.lot,
        number  = EXCLUDED.number;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS item_identifiers_legacy_insert ON item_identifiers;
CREATE TRIGGER item_identifiers_legacy_insert AFTER INSERT ON item_identifiers
  FOR EACH ROW WHEN (NEW.type = 'legacy') EXECUTE FUNCTION tag_sync_legacy_sticker();

DROP TRIGGER IF EXISTS item_identifiers_legacy_update ON item_identifiers;
CREATE TRIGGER item_identifiers_legacy_update AFTER UPDATE ON item_identifiers
  FOR EACH ROW WHEN (NEW.type = 'legacy' OR OLD.type = 'legacy')
  EXECUTE FUNCTION tag_sync_legacy_sticker();

-- Stickers that already exist when this runs a second time.
INSERT INTO tag_legacy_stickers (identifier_id, item_id, color, lot, number)
SELECT id, item_id,
       split_part(value, '-', 1),
       CASE WHEN array_length(string_to_array(value, '-'), 1) = 3 THEN split_part(value, '-', 2) END,
       (string_to_array(value, '-'))[array_length(string_to_array(value, '-'), 1)]::bigint
  FROM item_identifiers
 WHERE type = 'legacy'
   AND value ~ '^[A-Z]+(-[A-Z0-9]+)?-[0-9]{1,15}$'
ON CONFLICT (identifier_id) DO NOTHING;

-- The EPC an item or unit is given for writing to a tag. Assigned once and
-- kept, so the number on the item page is the one that ends up on the tag.
-- GIAI-96 needs a serial that is unique under the company prefix, which the
-- sequence provides.
CREATE SEQUENCE IF NOT EXISTS tag_giai_serial_seq START 1;

CREATE TABLE IF NOT EXISTS tag_epcs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id     uuid REFERENCES item_units(id) ON DELETE CASCADE,
  scheme      text NOT NULL CHECK (scheme IN ('giai-96', 'bindex-96')),
  epc         text NOT NULL CHECK (epc ~ '^[0-9A-F]{24}$'),
  giai_serial bigint,
  -- Set once a label carrying this EPC has been sent to an encoder. From then
  -- on the EPC never changes, even if the company prefix does.
  encoded_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_epcs_epc ON tag_epcs (epc);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_epcs_item ON tag_epcs (item_id) WHERE unit_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_epcs_unit ON tag_epcs (unit_id) WHERE unit_id IS NOT NULL;

-- A bulk binding run: a fixed list of items or units, and each new tag read
-- binds to the next one. `history` is every bind and skip, newest last, so
-- the last one can be undone.
CREATE TABLE IF NOT EXISTS tag_bind_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  tag_type   text NOT NULL CHECK (tag_type IN ('rfid', 'nfc')),
  queue      jsonb NOT NULL DEFAULT '[]'::jsonb,
  position   integer NOT NULL DEFAULT 0,
  history    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tag_bind_sessions_status ON tag_bind_sessions (status, updated_at DESC);
