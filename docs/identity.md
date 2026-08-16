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

## Authorization and delegation foundation

PR 3 adds one Core-owned permission registry and evaluator. Built-in roles are
permission bundles, not authorization logic: `owner`, `administrator`,
`operator`, `viewer`, and `auditor` resolve through the
`identity_role_permissions` table. Unknown permissions, missing identities,
disabled principals, expired or revoked delegations, and insufficient grants
deny by default.

Machine credential scopes are intersected with the principal's effective
permissions. A delegation is an explicit, expirable, revocable record whose
permissions are intersected with the delegator's current authority, so a
delegator cannot grant authority it does not currently possess. Delegates do
not inherit the delegator's entire role set. Owner promotion/demotion requires
`roles.manage`, and the final usable Owner cannot be disabled or removed.

Authenticated dashboard and MCP dispatcher requests carry their principal
identity into the existing policy, approval, redaction, and audit path. The
Core authorization decision is an additional gate before tool execution;
existing source policy and approval checks remain authoritative and are not
duplicated. Legacy installation-wide API-key access remains an explicit
transitional compatibility path and is not the new authorization model.

Capability Packs do not own users, roles, credentials, or authorization. A pack
may optionally declare a Core permission requirement on a tool in its manifest,
for example `proxmox.vm.read`. That declaration is metadata and never grants
authority: the single Core dispatcher resolves the named permission against the
current principal, credential scope, delegation, and policy. Unknown or
unregistered permission names fail closed. Existing tool/risk declarations
remain the module-facade allowlist for what a pack may dispatch internally.

## Approval identity and brokered secret use

Task-originated approvals persist the stable requester, actor, and optional
acting-for principal IDs, the approval policy, the original argument digest,
and whether a human decision is required. Dashboard approve/reject operations
require `approvals.grant`. A human approver must be enabled and authorized;
agents and services cannot satisfy a human approval requirement, and a
requester or acting actor cannot self-approve it. The approval transaction
records `approved_by_principal_id` while preserving the existing encrypted
arguments and digest binding.

Connector and compute-provider credential resolution uses the existing
encrypted secret store. When an authenticated principal is present, Core
checks `secrets.use` at resolution time; the plaintext is passed only to the
governed provider call and is never included in connector/provider records or
approval/audit output. Legacy environment and unscoped resolver behavior is
retained only for pre-identity compatibility paths without an authenticated
principal and is not a substitute for a scoped identity credential.

Resource ownership and administration consume these Core services rather than
creating parallel identity stores. The dashboard Identity page is a view over
the principal routes; direct API calls receive the same server-side checks.

## Workflow execution identity

Workflow definition discovery uses `workflows.read`; running or resuming a
workflow uses `workflows.execute` through the Core dispatcher. Workflow runs
and their platform execution ledger rows persist requester, actor,
acting-for, and executor principal IDs. The runner carries the authenticated
request context into each governed step, so a workflow does not silently
become an unrestricted process-level Owner. Workflow definition ownership
(`core` or a named Capability Pack) remains separate from authorization.
