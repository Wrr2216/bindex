# Security

## Reporting a vulnerability

Please report security problems privately, using the repository's **Security**
tab and its **Report a vulnerability** form, rather than opening a public issue.
Include what you found, how to reproduce it, and what an attacker could do with
it.

You will get an acknowledgement within a few days. Once a fix is out, you are
welcome to write about it, and will be credited unless you would rather not be.

## What this project assumes

Bindex expects to run behind a reverse proxy that terminates TLS. It sets
`trust proxy` for one hop, so session cookies are marked secure and client
addresses in the logs are the real ones. Exposing it directly to the internet
over plain HTTP will send session cookies in the clear.

`AUTH_MODE=trusted` disables authentication entirely: every request is treated
as the owner. It exists for a home network or an authenticating proxy. Do not
use it anywhere a stranger can reach the port.

`SESSION_SECRET` signs session cookies. Anyone holding it can forge a session,
so treat it like a password and do not commit it. Changing it signs everyone
out, which is also how you revoke every session at once.

API keys are stored as SHA-256 hashes and shown once, at creation. They cannot
change settings, manage accounts, or export and restore backups; those stay
browser-only. A read-only key is rejected on any method other than GET or HEAD.

Passwords are hashed with scrypt at the OWASP-recommended cost, with a random
salt per password. A failed sign-in costs the same time as a successful one, so
the response cannot be used to work out which addresses have accounts.

## Supported versions

The latest release is the supported one. This is a young project; please upgrade
before reporting something you found on an older tag.
