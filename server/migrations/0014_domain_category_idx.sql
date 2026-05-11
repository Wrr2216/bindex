-- Keep domain items easy to filter by category and backfill existing domain rows.
CREATE INDEX IF NOT EXISTS idx_items_category ON items (category);

UPDATE items
   SET category = 'Domain'
 WHERE id IN (
   SELECT DISTINCT ii.item_id
     FROM item_identifiers ii
    WHERE ii.type = 'domain'
 )
   AND COALESCE(category, '') <> 'Domain';
