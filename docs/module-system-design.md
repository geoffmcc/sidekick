# Module System Design

Status: First-party builtin and bundled modules run through the lifecycle.
Untrusted third-party modules can be inspected, installed, configured and
removed, but activation fails closed until an OS-enforced isolation backend is
available. Verified date: 2026-10-20

Implemented: manifest validation, lifecycle persistence (`platform_modules`),
entry-hash integrity binding with attested re-binding for builtin releases,
activation into the shared registry, per-dispatch lifecycle gating,
deny-by-default module permissions with a risk cap, trusted-builtin SQL
migrations, health checks/recovery/alerts, periodic health sweeps, and — as of
Capability Packs v1 — the full third-party path: safe package inspection, a
managed module store, verified `entry_point` loading with whole-package
integrity verification, real install/configure/enable/disable/upgrade/uninstall,
a derived health model, and cross-process convergence when code changes.

Verified locally by the bundled `data-utilities` module and the Developer
capability pack. Third-party pack fixtures are verified to remain installed
but inactive when OS isolation is unavailable.

Still unavailable: an OS sandbox and broker for third-party modules. Other
gaps include managed module SQL migrations, package signing, remote
distribution, and module dependency resolution beyond manifest declaration.

## Required Isolation Architecture (Not Yet Implemented)

The current `createModuleServices()` facade is an application-level API
boundary, not a containment boundary: executable handlers still run in the
Core process and can use Node APIs to bypass it. Whole-package hashes and
first-party provenance establish integrity/provenance only; neither limits
what code can do after loading. Keep third-party modules fail-closed until the
following design is implemented and its OS boundary is integration-tested.

### Process and broker contract

1. Core verifies package digest, signer/release provenance, manifest,
   configuration, lifecycle state, and declared capability set before launch.
   These checks establish what is launched; the OS boundary contains it.
2. A dedicated worker process runs under a distinct, unprivileged OS identity.
   It receives only the immutable package mount, bounded configuration, and a
   per-launch broker endpoint. It receives no Core database, global secret
   store, service credentials, inherited environment secrets, Core IPC, or
   host control socket.
3. A small versioned JSON RPC protocol is the only authority channel. The
   worker returns descriptor metadata at startup and receives tool invocations
   by request ID. Core validates names, schemas, declared permissions, size,
   timeout, and lifecycle state. Worker responses are data, never executable
   Core callbacks.
4. Broker operations are explicit and typed: tool dispatch through the
   canonical dispatcher with the module identity; namespaced storage; named
   secret references; and filesystem/network operations only when separately
   declared, scoped, and granted. Remove direct shared-process `paths`, secret,
   and storage functions from isolated module facades. A broker request never
   inherits the launching user's identity or Core's ambient privileges.
5. Core revalidates current module state, identity, capability grant, project
   scope, approval, and policy at every broker call. It records an audit event
   that binds module/package digest, request ID, tool/action, decision, and
   result. A worker cannot write authoritative audit records.
6. Worker startup, protocol, health, or resource-limit failure denies
   activation or terminates the worker. There is no in-process fallback.
   Disable/revoke removes broker authority first, then terminates the worker;
   recovery repeats current verification and grants from scratch.

### Enforceable backend profiles

The first production backend should be Linux-only and fail closed elsewhere.
For hostile third-party code, require a dedicated worker identity and a
microVM or user-space kernel boundary (for example, a gVisor/runsc runtime)
with a read-only package mount, empty/default-deny network namespace, no host
IPC/socket mounts, no capabilities, no-new-privileges, seccomp, and explicit
memory/CPU/process/time limits. Pin and verify the runtime binary and profile;
health must report the active backend, profile digest, enforcement state, and
failure reason. A generic OCI container sharing the host kernel is not by
itself sufficient evidence for hostile-code containment.

Windows and other platforms remain unavailable until a backend with equivalent
external enforcement, identity separation, filesystem/network controls, and
resource limits is implemented and adversarially verified. Do not silently
fall back to a weaker Linux profile, Node worker thread, VM context, command
filter, or in-process loader. First-party code may keep the existing trusted
in-process path temporarily, but the residual risk from supply-chain or
release compromise remains explicit; it is not called sandboxed.

### Acceptance gate before any extension executes

- Demonstrate from inside a real worker that host secrets, Core database,
  unrelated files, Core services, arbitrary network destinations, and host
  process creation are inaccessible under the configured profile.
- Demonstrate that each broker permission works only in its declared scope,
  is denied after revocation, and is attributable in the Core audit stream.
- Verify startup failure, worker crash, timeout, resource exhaustion, malformed
  RPC, duplicate request ID, and Core restart all fail closed without stale
  authority or automatic in-process fallback.
- Bound concurrent workers and per-worker memory, CPU, processes, wall time,
  request/response bytes, and log volume.
- Exercise upgrade, disable, uninstall, recovery, and multi-Core-process
  convergence with disposable fixtures. Do not run escape tests on production.

## Third-Party Module Path (B9)

### Managed installation

An installed module never runs from the directory the operator pointed at.
Installation copies the reviewed package into a Sidekick-managed location:

```text
<SIDEKICK_DATA_DIR>/modules/<module-name>/<version>/
<SIDEKICK_DATA_DIR>/modules/<module-name>/.staging-<random>/   (upgrades)
```

Owning the runtime location is what makes the integrity model mean anything:
the whole-package hash recorded at install is recomputed against these bytes
before any entry point is loaded, and the operator's source tree can change
afterwards without silently changing what Sidekick executes.

`platform_modules` gained `install_path`, `package_hash` and `provenance_json`
(migration `036_capability_packs.sql`, mirrored by `ensurePlatformModuleSchema`).

### Inspection before execution

`inspectPackageForInstall` reads the manifest as data, walks the file tree,
computes the deterministic whole-package hash, and reports identity, display
name, version, manifest, declared entry point, files, compatibility,
contributed tools, configuration requirements and source provenance — without
requiring, importing or evaluating any package code.

It refuses, with an explicit reason: path traversal, entry points escaping the
package root, symlinks, non-regular files, malformed manifests, invalid
versions, invalid entry points, duplicate module identity, descriptor
collisions with the live registry (including aliases and generated capability
names), built-in tool shadowing, and files the packaging policy forbids
(`.env`, `*.pem`, `*.key`, `*.p12`, `credentials.json`, `secrets.json`).

### Verified loading

For trusted first-party code before it is executed (`src/modules/entry-loader.js`):

1. the module has a managed installation, inside the managed store;
2. the installed package still hashes to the value recorded at install;
3. the declared entry point exists, is a regular file, and resolves inside the
   installation;
4. the entry file still hashes to the recorded entry hash;
5. the manifest is compatible with this Sidekick build;
6. configuration requirements are satisfied;
7. the operator left the module in a runnable state.

Only then is the file required, and only by an absolute path derived from the
managed installation. Third-party entries are rejected before file access or
`require()` unless a future verified OS isolation backend supplies the
boundary. A modified installed package also fails integrity verification.

### Upgrade

The candidate is inspected, its identity verified, versions compared, staged
beside the live installation, hash-verified, promoted, and only then activated
for a trusted first-party module. Third-party upgrades that would require
activation fail closed before changing the installed package until isolation
is available.
Compatible configuration is preserved; trusted-builtin migrations apply;
pending managed-module SQL migrations are rejected before DB access; stale
descriptors from the old version are removed before the new ones register. The
previous installation is retained until activation succeeds, and a failed
upgrade restores the previous version and re-enables it if it had been running.

Ambiguous replacement is refused unless explicit: same version needs
`allowSameVersion`, a lower version needs `allowDowngrade`.

### Uninstall

Runtime contributions first, then the managed package directory, then the
registration row. Module-owned configuration and lifecycle state go with the
row; rows a module's migrations wrote into published `platform_*` tables are
retained unless the manifest declares its data removable AND the operator asks.
Kernel ledger events and tool logs are never deleted — history about what the
system did survives the removal of the thing that did it.

### Cross-process convergence

Each process records the code identity it registered (version, entry hash,
package hash). Reconciliation compares that against the persisted row, so an
upgrade performed in another process drops the stale registration here and
re-activates from the new managed installation without a restart. Node's
require cache is purged for the installation subtree, so the new bytes are the
ones that execute. Where a process genuinely cannot bring the code up, health
reports `restart_required` rather than pretending otherwise.

### Derived health

`src/modules/lifecycle.js` computes health from the record and live process
state: `healthy`, `disabled`, `unhealthy`, `configuration_required`,
`incompatible`, `integrity_failure`, `load_failure`, `restart_required`,
`isolation_unavailable`, `not_installed` — each with per-component evidence (package integrity,
compatibility, configuration, in-process activation, the module's own
`healthCheck()`).

Module health includes a separate `isolation` projection. Untrusted modules
report `status: unavailable`, `boundary: none`, and `enforced: false`; trusted
first-party code reports `trusted_in_process`. Functional health is not a
containment guarantee.

### Trust model

**Untrusted third-party modules do not currently execute.** Installation is
available for review and configuration, but activation, recovery, and upgrades
that would run package code fail closed with `isolation_unavailable`. First-
party exceptions require source verification or an independently registered
bundled-pack provenance record whose version and digest match. No module is
described as sandboxed; third-party execution requires a future OS boundary
and broker.

## Manifest Contract

Modules declare identity, version, Sidekick compatibility, dependencies, optional dependencies, capabilities, configuration schema, permissions, tools, workflows, agents, connectors, published/consumed events, dashboard extensions, migrations, background services, health, lifecycle, disable/uninstall behavior, and retention.

The manifest is validated before activation. Handlers receive narrow versioned service facades, not the database or transport objects.

## Registration And Security

The loader supplies descriptors to the existing `buildBuiltinRegistry`/`createRegistry` path. Canonical names, aliases, schemas, handlers, risks and categories have one owner. Duplicate names and aliases fail closed using the current registry rules. `TOOL_DEFS` remains only an ordering compatibility anchor.

Modules call `dispatchTool` or source-specific wrappers. They never call handler maps, bypass policy, or implement approval. Module permissions are declarative requirements checked by shared policy/capability services; a module cannot grant itself permission.

## Lifecycle And Persistence

```text
discovered -> validated -> installed -> configured -> enabled -> healthy
                                      |                 |
                                      +-> disabled <----+
                                      +-> uninstalling -> uninstalled
```

Disable stops new work, drains or terminates module jobs, and retains data. Uninstall disables registrations and requires an explicit retention decision; retained evidence/audit data is never silently deleted.

**`platform_extensions` convergence decision.** The kernel's `platform_extensions` CRUD (`registerExtension`, `activateExtension`, …) was a second, module-ish lifecycle. It is **retired as a module concept**: it has no production caller (only `test/extension-docs.test.js` exercises it), `platform_modules` is the single module authority, and Capability Packs v1 builds on the module subsystem rather than creating a third extension model. The table and its CRUD remain in the schema and the kernel surface for backward compatibility and are not part of any lifecycle; nothing in the module, pack or workflow path reads or writes them.

SQL migrations against Core's SQLite database are currently allowed only for source-verified first-party builtins. Managed/discovered modules that declare pending SQL migrations fail closed before execution: the existing lexical SQL checks are not an SQLite authorization boundary, and a bracket-quoted private table identifier bypassed their table-name scan. Managed modules should use the scoped pack storage service (`services.storage`) for namespaced state. A future isolated migration API must provide per-module data ownership and OS-enforced separation before third-party migrations are re-enabled. Config is validated before enablement; secrets are references to shared secret handling. Health covers dependencies, config, jobs and errors, not merely manifest parsing.

Registered modules bind their declared entry point to a SHA-256 code hash. Enablement verifies the path, binding metadata, repository containment, and current file hash before constructing descriptors; a mismatch fails closed.

Phase 6 discovery is intentionally separate from activation: bounded scans of `modules/` and `plugins/` parse `manifest.json` (or `sidekick.module.json`) deterministically, reject symlinked module directories and duplicate names, and return candidates/errors without registering or executing module code.

The first packaging slice is likewise inspection-only: it produces a deterministic file inventory and aggregate hash, excludes dependency and VCS directories, and rejects symlinks and sensitive files. Archive creation, installation, and activation remain separate operations.

Installation accepts only a discovered candidate, validates a regular in-root entry file, persists its normalized path and hash, and starts at `validated`. It never loads module code; migration, enablement, and activation remain explicit lifecycle steps.

Configuration is a separate boundary after installation: it validates the supplied config against the manifest schema and transitions only `installed -> configured`. It does not load, enable, or activate module code.

Activation accepts only a configured module and delegates loading, ownership verification, policy wiring, and the `enabled` transition to the shared loader. An unconfigured module cannot skip the configuration boundary through this path.

Health checks accept only active `enabled` or `healthy` modules and a synchronous entry `healthCheck()` returning `{ ok, details? }`. Results and timestamps are persisted; a passing check transitions `enabled -> healthy`, while a failed check records the result and transitions to `error`.

The `module` management surface exposes the persisted health payload and last-check timestamp read-only through `action: "health"`; it does not execute a new health check or mutate lifecycle state.

The dashboard summary includes the same read-only module health rows, aggregate counts, and active-process mismatch/error count so operators can see lifecycle health without triggering module code.

Each completed check also appends a `module.health.check` event to the kernel
ledger. Because the index, dashboard, and agent processes each run the same
scheduled sweep, a successful check whose most recent ledger entry for that
module is already a recent success is coalesced rather than appended, so a
steady-state module does not emit duplicate healthy rows (failures and
lifecycle transitions are always recorded; the window is configurable through
`SIDEKICK_MODULE_HEALTH_COALESCE_MS`, and `0` disables coalescing). Module
reports and dashboard rows expose a bounded recent history from that ledger,
allowing operators to distinguish current state from recent check
outcomes without unbounded response growth. The history lookup is served by the
`idx_platform_events_type_subject` index (migration 080) so it does not scan
the full ledger. Exceptions and malformed or asynchronous health results are
normalized into a failed check, persisted, and transitioned to `error` so the
acceptance path is observable and recoverable rather than silently
disappearing.

The `module` management surface also exposes `action: "check"` for builtin entries with a health contract. It executes the bounded check through the health boundary and returns the persisted lifecycle result; `action: "health"` remains read-only.

An error-state module can be explicitly recovered with `action: "recover"`: stale local registrations are removed, the shared loader performs the error -> enabled transition, and the health contract must pass before recovery returns successfully.

MCP, dashboard, and agent startup schedule an unref'd periodic builtin-module health sweep. The sweep reuses the explicit health boundary, records results, and reports failures without blocking process startup.

Failed sweep results also emit a structured `module.health.alert` kernel event and a bounded operator log message; healthy sweeps emit neither.

Events use the future Event Runtime; appending a ledger event is not delivery. Jobs use common execution/claim/recovery semantics. Dashboard extensions expose service-backed routes/views and store no authoritative dashboard-only state.

## First Proof

Use the already extracted `data-utilities` family as a thin module-like registration proof after this contract exists. It is bounded and exercises descriptor ownership, schema validation, lifecycle, health and catalog exposure without conflating security-research domain design with runtime extraction. Existing extension CRUD is not sufficient proof.

## Rejected Designs

- A parallel module registry or dispatcher.
- Module-local policy or approvals.
- Module-specific database/migrations.
- Module-owned projects, executions, events, artifacts or model registries.
- Private shared-table coupling to the Security Research Workbench.
