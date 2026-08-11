# Module System Design

Status: Proposed module contract
Verified commit: d2db2658ef0fbf862c64b09315279562caa5bb8e
Verified date: 2026-08-05T16:16:46-04:00

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

Disable stops new work, drains or terminates module jobs, and retains data. Uninstall disables registrations and requires an explicit retention decision; retained evidence/audit data is never silently deleted. Existing `platform_extensions` can hold metadata while the module loader owns behavior.

Module migrations use the existing ordered runner and SQLite database. They use logical namespaces and may reference only published platform tables. Config is validated before enablement; secrets are references to shared secret handling. Health covers dependencies, config, jobs and errors, not merely manifest parsing.

Registered modules bind their declared entry point to a SHA-256 code hash. Enablement verifies the path, binding metadata, repository containment, and current file hash before constructing descriptors; a mismatch fails closed.

Phase 6 discovery is intentionally separate from activation: bounded scans of `modules/` and `plugins/` parse `manifest.json` (or `sidekick.module.json`) deterministically, reject symlinked module directories and duplicate names, and return candidates/errors without registering or executing module code.

The first packaging slice is likewise inspection-only: it produces a deterministic file inventory and aggregate hash, excludes dependency and VCS directories, and rejects symlinks and sensitive files. Archive creation, installation, and activation remain separate operations.

Installation accepts only a discovered candidate, validates a regular in-root entry file, persists its normalized path and hash, and starts at `validated`. It never loads module code; migration, enablement, and activation remain explicit lifecycle steps.

Configuration is a separate boundary after installation: it validates the supplied config against the manifest schema and transitions only `installed -> configured`. It does not load, enable, or activate module code.

Activation accepts only a configured module and delegates loading, ownership verification, policy wiring, and the `enabled` transition to the shared loader. An unconfigured module cannot skip the configuration boundary through this path.

Health checks accept only active `enabled` or `healthy` modules and a synchronous entry `healthCheck()` returning `{ ok, details? }`. Results and timestamps are persisted; a passing check transitions `enabled -> healthy`, while a failed check records the result and transitions to `error`.

The `module` management surface exposes the persisted health payload and last-check timestamp read-only through `action: "health"`; it does not execute a new health check or mutate lifecycle state.

The dashboard summary includes the same read-only module health rows, aggregate counts, and active-process mismatch/error count so operators can see lifecycle health without triggering module code.

The `module` management surface also exposes `action: "check"` for builtin entries with a health contract. It executes the bounded check through the health boundary and returns the persisted lifecycle result; `action: "health"` remains read-only.

An error-state module can be explicitly recovered with `action: "recover"`: stale local registrations are removed, the shared loader performs the error -> enabled transition, and the health contract must pass before recovery returns successfully.

Events use the future Event Runtime; appending a ledger event is not delivery. Jobs use common execution/claim/recovery semantics. Dashboard extensions expose service-backed routes/views and store no authoritative dashboard-only state.

## First Proof

Use the already extracted `data-utilities` family as a thin module-like registration proof after this contract exists. It is bounded and exercises descriptor ownership, schema validation, lifecycle, health and catalog exposure without conflating security-research domain design with runtime extraction. Existing extension CRUD is not sufficient proof.

## Rejected Designs

- A parallel module registry or dispatcher.
- Module-local policy or approvals.
- Module-specific database/migrations.
- Module-owned projects, executions, events, artifacts or model registries.
- Private shared-table coupling to the Security Research Workbench.
