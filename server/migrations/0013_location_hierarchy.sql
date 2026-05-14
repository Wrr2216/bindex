-- Locations can nest: a rack holds containers (for example Rack 1 holding 1A, 1B and 1C).
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_locations_parent_id ON locations(parent_id);
