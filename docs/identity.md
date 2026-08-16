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

This is PR 1 of the Identity & Authorization project. Authentication sessions,
scoped machine credentials, the Core permission evaluator, bounded delegation,
approval identity, resource/workflow authority, and administration routes are
subsequent PRs and must consume this Core model rather than create parallel
identity stores.
