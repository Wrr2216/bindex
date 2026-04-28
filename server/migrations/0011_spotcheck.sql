-- Spot-check audit: flag items possibly-missing and record who last verified them.
ALTER TABLE items ADD COLUMN IF NOT EXISTS last_spot_checked_at  timestamptz;
ALTER TABLE items ADD COLUMN IF NOT EXISTS last_spot_checked_by  text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS flagged_missing       boolean NOT NULL DEFAULT false;

-- Simple key/value app settings (e.g. spot-check enabled).
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
