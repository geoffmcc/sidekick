# Capability Packs

Status: shipped (Capability Packs v1)
Depends on: B9 third-party module lifecycle (complete)

Sidekick Core no longer has to absorb every future area of functionality. A
**capability pack** is an installable, manageable **area of competence**, built
from the subsystems Sidekick already owns.

## The layers, and what each one is

| Layer | What it is | Where it lives |
|---|---|---|
| **Tool** | One governed callable operation, with a schema, a risk class, policy, approval and audit. | `src/tools/families/*`, module-contributed descriptors |
| **Module** | A runtime implementation contributed to Sidekick: code that builds tool descriptors and reports health. | `platform_modules`, `src/modules/*` |
| **Workflow** | A durable, reusable multi-step execution defined as data and run through the tool dispatcher. | `platform_workflow_definitions`, `platform_workflows`, `src/workflows/*` |
| **Capability Pack** | An installable area of competence composed from modules, workflows, knowledge and configuration. | `platform_capability_packs`, `src/packs/*` |
| **Connector** | A managed relationship with an external service or system. | **Future work — B7.** `platform_connectors` exists; no real provider is wired. |
| **Learned Capability** | Reusable behaviour created through Sidekick's `teach` / `evolve` mechanisms. | `generated_capabilities`, `src/evolve/*` |

These layers **compose**; they do not replace one another. A pack owns modules,
workflows and knowledge — it does not own their runtime state, and it is not a
second plugin system.

## Ownership

```
Capability Pack
    ├── owns module(s)                 → installed via the module lifecycle
    ├── owns workflow definitions      → registered in the definition registry
    ├── owns knowledge assets          → installed into the knowledge store
    ├── owns configuration schema      → validated, handed to opted-in modules
    └── identifies contributed tools   → through its modules' descriptors
```

But the authorities stay where they already were:

```
module runtime state       → platform_modules (module subsystem)
workflow execution state   → platform_workflows / platform_execution* (kernel)
project identity           → platform_projects (project subsystem)
tool invocation history    → tool_logs (canonical logging/audit)
knowledge content          → knowledge (knowledge store)
```

`platform_capability_pack_components` records *which pack owns which component*
so that disable, upgrade and uninstall can act coherently across those
subsystems. It is a join, not a competing source of truth.

## The manifest

A pack package is a directory containing `sidekick.pack.json`:

```json
{
  "schema_version": 1,
  "name": "developer",
  "display_name": "Developer / Software Engineering",
  "version": "1.0.0",
  "description": "…",
  "publisher": "Sidekick",
  "compatibility": { "sidekick": ">=1.0.0" },
  "modules": [
    { "name": "developer-tools", "path": "modules/developer-tools",
      "entry_point": "entry.js", "config_from_pack": true }
  ],
  "workflows": [ { "path": "workflows/repository-recon.json" } ],
  "knowledge": [
    { "path": "knowledge/verification-strategy.md",
      "title": "…", "category": "development", "tags": ["developer"] }
  ],
  "requires": {
    "tools": ["git", "bash", "read", "list", "search"],
    "optional_tools": ["github", "ci_status"]
  },
  "configuration": { "schema": { "…JSON Schema…" }, "defaults": { } }
}
```

Every field has runtime meaning:

- `modules[]` are installed through the module subsystem (B9), into the managed
  module store. `config_from_pack: true` means the pack's validated
  configuration *is* that module's configuration — the only configuration
  coupling between a pack and its modules, and it is explicit.
- `workflows[]` are validated as definitions at inspection time and registered
  in the workflow definition registry.
- `knowledge[]` become rows in the `knowledge` table, tagged `pack:<name>`, so
  agents find pack knowledge through the ordinary `knowledge` tool.
- `requires.tools` is verified at install; a missing required tool blocks the
  install. `requires.optional_tools` is reported by health as available or not.
- `configuration.schema` validates pack configuration; `defaults` are applied.

## Lifecycle

```
inspect → install → configure → enable → health
                              ↘ disable → enable
                                upgrade
                                uninstall
```

Run through the `capability` tool (MCP/agent) or the dashboard **Capabilities**
page. Both go through the same governed path.

### Inspect

Reads the manifest, walks the package, computes a deterministic whole-package
hash, recursively inspects each owned **module package** with the module rules,
validates each workflow definition, and checks compatibility and required
tools. Nothing is executed. `installable: false` with an explicit `problems`
list is the answer for anything disqualifying.

### Install

1. inspect the package;
2. refuse it outright if anything was disqualifying;
3. copy exactly the inspected files to `<SIDEKICK_DATA_DIR>/packs/<name>/<version>/`;
4. re-hash the managed copy and require it to equal the inspected hash;
5. register the pack, then install owned modules (module subsystem), register
   owned workflow definitions, and install owned knowledge;
6. record component ownership.

A newly installed pack is **disabled** (`state: installed`). Installing code
and activating code are separate operator decisions. A failure at any point
rolls the whole installation back — there is no half-installed pack.

Duplicate ownership is refused: two packs may not claim the same module,
workflow or knowledge asset, and a pack may not claim a module that is already
registered independently.

### Configure

Validated against the manifest's JSON Schema with defaults applied, persisted,
and propagated to modules that declared `config_from_pack`. Reconfiguring an
*active* module rebuilds its descriptors, because handlers close over the
configuration they were given.

Secrets do not belong in pack configuration. Use Sidekick's secret store and
reference secrets by name.

### Enable / disable

Enable activates owned modules through the module lifecycle (so integrity,
compatibility and configuration checks all run), moves workflow definitions to
`registered`, and enables knowledge rows. If any module fails to enable, the
already-activated ones are rolled back and the pack reports the component
failure — a partially live pack is never advertised as enabled.

Disable removes the **active capabilities**: module descriptors leave the
registry, workflow definitions become un-runnable, knowledge rows are
withdrawn from search. Nothing is destroyed — registrations, definitions and
knowledge content all survive, and historical execution records are untouched.

### Upgrade

Stages the candidate beside the live installation, verifies it, promotes it,
then upgrades owned modules through the module lifecycle, replaces owned
workflow definitions and knowledge, removes components the new version no
longer contains, and rewrites ownership rows to the new version. Configuration
is preserved unless the operator supplies new values, and must still validate
against the new schema.

Ambiguous replacement is refused unless explicitly allowed:

| Situation | Default |
|---|---|
| higher version | proceeds |
| same version, identical package | refused |
| same version, different package | refused (`allow_same_version` to proceed) |
| lower version | refused (`allow_downgrade` to proceed) |
| incompatible with this Sidekick | refused |

A failed upgrade never destroys the working installation.

### Uninstall

Disables the pack, uninstalls owned modules through the module lifecycle,
removes owned workflow definitions and knowledge, removes ownership rows,
removes the managed package directory, and removes the pack record.

**Historical execution and audit evidence is preserved.** Tool logs, kernel
ledger events and completed workflow runs survive the removal of the thing that
produced them.

## Health

Pack health is **derived from components**, never set by hand:

```
Developer Pack
  compatibility:             ok (>=1.0.0)
  configuration:             valid
  module developer-tools:    healthy
  workflow definitions (7):  registered
  knowledge (8):             enabled
overall: healthy
```

| Status | Meaning |
|---|---|
| `healthy` | enabled, and every component is usable |
| `disabled` | not enabled, and its components are correctly parked |
| `degraded` | enabled, with a non-essential component out of step |
| `configuration_required` | configuration is missing or invalid |
| `incompatible` | the pack or a module requires a different Sidekick |
| `integrity_failure` | an owned module's package no longer hashes to its recorded value |
| `component_failure` | an owned component cannot be used |
| `restart_required` | enabled in the ledger, but this process cannot activate the code |

A pack whose required component is unusable is never reported healthy.

## First-party bundled packs

Bundled packs ship inside the signed Sidekick repository under `packs/`. They
differ from third-party packs in **trust** (`provenance: first_party`, source
`bundled`) and in nothing else: same manifest, same managed store, same
lifecycle, same health model. That is deliberate — a first-party pack that took
a shortcut would stop exercising the platform it exists to prove.

## Workflow definitions

Sidekick already owned workflow *execution* state (`platform_workflows`,
`platform_workflow_steps`, the execution ledger). What it lacked was a durable
place for reusable *definitions*. `platform_workflow_definitions` is that
missing half, and `src/workflows/runner.js` executes definitions through the
existing primitives — it is not a second engine.

A definition is data:

```json
{
  "schema_version": 1,
  "name": "developer/repository-recon",
  "version": "1.0.0",
  "title": "Repository Reconnaissance",
  "description": "…",
  "mode": "read_only",
  "inputs": { "path": { "type": "string", "required": true } },
  "steps": [
    { "name": "profile", "tool": "dev_repo_profile",
      "args": { "path": "${inputs.path}" }, "expect": "json", "on_error": "fail" },
    { "name": "history", "tool": "git",
      "args": { "action": "log", "path": "${inputs.path}", "args": "-20" },
      "expect": "text", "on_error": "continue" }
  ],
  "result": { "repository": "${steps.profile.json.repository}" }
}
```

References are **resolved, never evaluated**:

| Reference | Resolves to |
|---|---|
| `${inputs.<key>}` | a validated workflow input |
| `${steps.<step>.json[.a.b[0]]}` | a prior step's parsed JSON result |
| `${steps.<step>.text}` | a prior step's textual result |
| `${steps.<step>.ok}` | whether a prior step succeeded |

There is no arithmetic, no function call, and no way to express anything the
resolver does not implement. A reference to a step that has not run yet is a
**validation error at registration time**, so a broken definition is caught
when a pack is inspected, not when an operator tries to run it.

### What a run inherits

Each step is dispatched with `callInternalTool`, so it carries the full
governed path: schema validation, tool policy, approvals, timeouts,
cancellation, redaction and audit logging. On top of that the runner provides:

- **durable state** — a kernel workflow with per-step rows and checkpoints;
- **project identity** — the run's platform execution carries the project;
- **approval continuation** — a step requiring approval parks the run in
  `waiting`, records where it stopped, and returns the approval id; the
  operator approves through the normal path and resumes with
  `workflow action="resume" run_id="…"`;
- **cancellation** — the execution claim is re-read before every step, so a
  cancel requested in another process stops the run at the next boundary;
- **execution history and provenance** — pack name, pack version, workflow
  version and definition checksum are recorded on the run.

`on_error: "continue"` records the step as **failed** while letting the run
proceed; the durable record and the cursor both stay accurate.

## Operator surfaces

### `capability` tool (risk: `critical`)

```
capability action="list"
capability action="available"
capability action="inspect"   name="developer"     # or path="/srv/pack"
capability action="install"   name="developer"     # or path=…, config={…}, enable=true
capability action="configure" name="developer" config={ "verification_mode": "full" }
capability action="enable"    name="developer"
capability action="disable"   name="developer"
capability action="health"    name="developer"
capability action="upgrade"   name="developer"     # or path=…, allow_same_version / allow_downgrade
capability action="uninstall" name="developer"
```

`critical` is the honest classification: installing or enabling a pack
activates executable module code inside the Sidekick process.

### `workflow` tool (risk: `high`)

```
workflow action="list"    [owner="developer"]
workflow action="show"    name="developer/repository-recon"
workflow action="run"     name="developer/repository-recon" inputs={ "path": "/srv/repo" }
workflow action="resume"  name="developer/repository-recon" run_id="wf_…"
```

### Dashboard → Capabilities

Shows installed packs (name, version, publisher, provenance, bundled/third
party, state, health, contributed modules/tools/workflows/knowledge) with
Details, Health Check, Enable/Disable, Upgrade and Uninstall; available bundled
packs with Inspect and Install; and inspection/installation from an approved
**server-local** path.

Every mutation is a POST to the dashboard API, which dispatches the governed
`capability` tool server-side. Browser code never mutates pack state directly.
The dashboard's existing authentication, IP allowlist, rate limiting and
Origin/CSRF checks apply. There is no remote marketplace in v1, and the browser
cannot browse server files.

## Security and trust model

**Installed pack modules are trusted executable code.** Node module code loads
into the Sidekick process. There is **no process isolation and none is
claimed**. What the platform provides is integrity, provenance and lifecycle
control:

| Control | Mechanism |
|---|---|
| Path traversal | entry points and manifest paths resolved and refused outside the package root |
| Symlinks | refused during inspection; never followed into a managed installation |
| Whole-package integrity | deterministic hash recorded at install, recomputed before every load |
| Mutation after install | hash mismatch fails closed before `require` runs |
| Arbitrary entry points | `require` only ever gets an absolute path derived from the managed store |
| Descriptor collisions | checked against the live registry, aliases and generated capability names |
| Built-in shadowing | a package that declares a built-in tool name is refused at inspection |
| Managed install path | writes confined to `<data>/modules` and `<data>/packs`; deletions refuse any path outside them |
| Secret leakage | packaging refuses `.env`, `*.pem`, `*.key`, `*.p12`, `credentials.json`, `secrets.json`; secrets belong in the secret store |
| Module migrations | data-only, restricted to published `platform_*` tables; DDL fails closed |
| Stale descriptors | disable removes registrations; the dispatcher re-checks persisted state on every call |
| Stale workflows | disable parks definitions; the runner refuses a non-`registered` definition |
| Downgrade / replay | same-version and downgrade replacement refused unless explicit |
| Dashboard authorization | existing auth, IP allowlist, rate limit and Origin/CSRF checks |
| Audit | every lifecycle operation and every workflow step is dispatched and logged |
| Redaction | inherited from the dispatcher and the tool result path |

Third-party module code runs with Sidekick's privileges. Treat installing a
third-party pack as equivalent to deploying code.

## Related documents

- `docs/module-system-design.md` — the module subsystem the pack lifecycle builds on
- `docs/developer-pack.md` — the first-party Developer pack
- `docs/platform-roadmap.md` — B9 status and the remaining residual roadmap
