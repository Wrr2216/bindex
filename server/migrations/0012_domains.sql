-- Domain names as tracked assets: expiry date on items + 'domain' identifier type.
ALTER TABLE items ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_items_expires_at ON items (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE item_identifiers DROP CONSTRAINT IF EXISTS item_identifiers_type_check;
ALTER TABLE item_identifiers ADD CONSTRAINT item_identifiers_type_check
  CHECK (type IN ('upc','serial','asset_tag','mac','sku','other','rfid','domain'));
