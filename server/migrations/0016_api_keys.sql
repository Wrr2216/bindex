-- API keys for programmatic (non-SSO) access via the x-api-key header.
-- Only the SHA-256 hash of a key is stored; the plaintext is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  key_last4     text NOT NULL,
  scope         text NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'read_write')),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
