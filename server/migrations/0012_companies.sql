-- Optional ownership grouping for locations, and so for the items in them.
-- Displayed under a name the deployment chooses (Company, Household, Site).
CREATE TABLE IF NOT EXISTS companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE locations ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS locations_company_id_idx ON locations (company_id);
