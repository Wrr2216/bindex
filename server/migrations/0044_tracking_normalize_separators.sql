-- Hardware reads and stored tags meet on one normalized form. Tag
-- commissioning stores an RFID or NFC tag as bare uppercase hex with spaces,
-- colons, dots and dashes removed, so a reader sending "04-A2-3B-11" has to
-- normalize the same way to find it. Mirrors normalizeCode() in
-- services/tracking/normalize.ts.
CREATE OR REPLACE FUNCTION tracking_normalize_code(v text) RETURNS text AS $$
  SELECT CASE
    WHEN regexp_replace(v, '[[:space:]:.-]', '', 'g') ~ '^[0-9A-Fa-f]+$'
      THEN upper(regexp_replace(v, '[[:space:]:.-]', '', 'g'))
    ELSE btrim(v)
  END;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- The function is immutable and indexed, so the indexes built with the old
-- rule are rebuilt.
REINDEX INDEX idx_item_identifiers_tracking_code;
REINDEX INDEX idx_item_units_tracking_serial;
