-- Initial schema.
-- gen_random_uuid() is built into Postgres 13+. pg_trgm powers fuzzy search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  oid         text PRIMARY KEY,
  email       text NOT NULL,
  name        text NOT NULL,
  last_login  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  address     text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  description        text,
  brand              text,
  model              text,
  category           text,
  primary_image_url  text,
  parent_item_id     uuid REFERENCES items(id) ON DELETE SET NULL,
  location_id        uuid REFERENCES locations(id) ON DELETE SET NULL,
  quantity           integer NOT NULL DEFAULT 1,
  status             text NOT NULL DEFAULT 'active',
  enrichment_source  text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(name, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(brand, '') || ' ' ||
      coalesce(model, '') || ' ' ||
      coalesce(category, ''))
  ) STORED
);

CREATE TABLE IF NOT EXISTS item_identifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('upc','serial','asset_tag','mac','sku','other')),
  value       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- One physical code maps to exactly one item.
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_identifiers_value ON item_identifiers (value);
CREATE INDEX IF NOT EXISTS idx_item_identifiers_item ON item_identifiers (item_id);

CREATE TABLE IF NOT EXISTS item_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  url         text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  sort        integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_item_images_item ON item_images (item_id);

CREATE TABLE IF NOT EXISTS item_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid REFERENCES items(id) ON DELETE SET NULL,
  user_oid    text,
  action      text NOT NULL CHECK (action IN ('created','updated','scanned','moved','deleted')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_item_events_item ON item_events (item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS enrichment_cache (
  code        text PRIMARY KEY,
  provider    text NOT NULL,
  payload     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- Search indexes.
CREATE INDEX IF NOT EXISTS idx_items_search_tsv ON items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_items_name_trgm ON items USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_brand_trgm ON items USING gin (brand gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_model_trgm ON items USING gin (model gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items (parent_item_id);
CREATE INDEX IF NOT EXISTS idx_items_location ON items (location_id);

-- Session store for connect-pg-simple.
CREATE TABLE IF NOT EXISTS session (
  sid    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON session (expire);
