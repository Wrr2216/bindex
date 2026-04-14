-- App-hosted item photos (captured from the device camera or uploaded).
-- Bytes live in Postgres so they survive source link-rot and container redeploys.
CREATE TABLE IF NOT EXISTS item_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  mime        text NOT NULL,
  bytes       bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_item_photos_item ON item_photos (item_id);
