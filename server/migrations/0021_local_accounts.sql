-- Accounts that do not depend on an external identity provider.
--
-- The users table was written for OpenID Connect, where the primary key is the
-- subject claim. It keeps that shape: a local account uses the synthetic
-- subject `local:<uuid>` and an SSO account uses `<issuer-host>:<sub>`, so
-- foreign keys elsewhere (created_by, user_oid, checked_out_by) are unaffected.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role          text NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled      boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at    timestamptz NOT NULL DEFAULT now();

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member'));

-- Email is the login identifier for local accounts and the match key when an
-- SSO login lands on an account an administrator created ahead of time.
UPDATE users SET email = lower(email) WHERE email <> lower(email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email) WHERE email <> '';

-- Anyone who could already sign in kept full access before roles existed.
UPDATE users SET role = 'admin' WHERE role = 'member';
