-- NinjaOne OAuth2 authorization_code grant: persist the refresh token so
-- unattended syncs can mint access tokens without re-prompting a human.
-- Single row keyed by provider (currently only 'ninjaone').
CREATE TABLE IF NOT EXISTS ninjaone_tokens (
  provider          text PRIMARY KEY DEFAULT 'ninjaone',
  refresh_token     text NOT NULL,
  access_token      text,
  access_expires_at timestamptz,
  scope             text,
  connected_by      text,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
