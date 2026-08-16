# Core Identity Foundation

Sidekick is one local installation and one trust domain. It is not a
multi-tenant isolation platform.

The identity foundation stores stable opaque principals in SQLite. Supported
principal types are `human`, `agent`, `service`, `automation`, and `system`.
Human login records are separate from the principal record, so renaming or
disabling an account does not change historical attribution. Passwords are
stored only as salted scrypt verifiers with a versioned format label; identity DTOs never
include password hashes.

On a fresh installation, `bootstrapOwner` creates the first human account and
assigns the Owner role inside one immediate SQLite transaction. The bootstrap
record is a singleton, so it cannot be replayed and concurrent attempts cannot
create two initial Owners. There is no default password. Lifecycle events are
stored in the identity audit table with principal IDs and without password or
credential material.

## Authentication foundation

PR 2 adds SQLite-backed browser sessions and scoped machine credentials. A
session token is opaque to the database: only its SHA-256 verifier is stored.
Sessions have expiry, last-use tracking, server-side invalidation, and are
rejected when the principal is disabled. Browser sessions use an HttpOnly,
SameSite cookie and are invalidated on password change.

Machine credentials belong to a principal and include a bounded scope list,
expiry, revocation, rotation, creation metadata, and last-use tracking. The
raw credential is returned only by the create/rotate response; normal listing
and database records expose metadata and verifier material only. Credential
authentication is checked on every MCP request, so expiry, revocation, and
principal disablement take effect without a stale authorization cache.

The dashboard exposes local bootstrap, login, logout, current-account,
password-change, and administrator credential lifecycle routes. Before the
first Owner exists, all other dashboard routes fail closed. Existing
installation-wide API-key clients remain an explicit compatibility path while
they migrate to named scoped credentials; it is not the long-term identity
model.

Owner recovery uses a short-lived, single-use token generated under local host
control. Recovery tokens are stored only as hashes, expire quickly, invalidate
Owner sessions, and cannot be replayed through the dashboard or MCP API.

Headless administration is available through `scripts/identity-admin.js`.
Bootstrap and recovery password material are read from standard input; raw
passwords and recovery tokens should not be placed in shell arguments or logs.

The central permission evaluator, bounded delegation, approval identity,
resource/workflow authority, and full administration policy remain subsequent
PRs. They must consume this Core authentication model rather than create
parallel identity stores.
