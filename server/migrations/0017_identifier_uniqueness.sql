-- Identifier uniqueness: only identity-bearing codes are globally unique.
--
-- A UPC/SKU identifies a *product*, not a unit, so several distinct items can
-- legitimately carry the same one (two identical iPads bought for two sites).
-- The old global unique index rejected that with a raw constraint error, which
-- surfaced as a 500 when adding an item whose code was already on file.
DROP INDEX IF EXISTS uq_item_identifiers_value;

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_identifiers_identity_value
  ON item_identifiers (value)
  WHERE type IN ('serial', 'asset_tag', 'mac', 'rfid');

-- Product codes may now repeat, so keep a plain index for scan resolution.
CREATE INDEX IF NOT EXISTS idx_item_identifiers_value ON item_identifiers (value);
