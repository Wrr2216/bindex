-- Allow RFID/NFC tag UIDs as an identifier type.
ALTER TABLE item_identifiers DROP CONSTRAINT IF EXISTS item_identifiers_type_check;
ALTER TABLE item_identifiers ADD CONSTRAINT item_identifiers_type_check
  CHECK (type IN ('upc','serial','asset_tag','mac','sku','other','rfid'));
