# Security Research pack

The Security Research pack turns Sidekick into a governed, reproducible,
auditable framework for **authorized** security research. It organizes work into
campaigns, hypotheses, durable runs, bounded probes, evidence with integrity and
redaction, deterministic comparison, validation and report material — and it
does so by **composing existing Sidekick capabilities** through the normal
policy/approval/audit path rather than reimplementing them: command probes
dispatch the governed `bash` tool, HTTP probes dispatch `web_fetch`, and its
workflows compose the `git` tool. Named environments describe *where* a probe
runs, and a `proxmox` environment composes the Proxmox pack (`proxmox_provision`
/ `proxmox_guest`) to provision and tear down a disposable lab — with *which*
lab supplied entirely by runtime configuration, never committed.

Disposable labs can be made explicit with `lab_profiles`. A profile is resolved
into a run environment with an operator-facing `environment_label`,
`target_allowlist`, explicit `egress` (`none` or `restricted`), `topology`
(`single_node` by default), and opaque `rollback` metadata. Starting a run first
performs harmless evidence, scope, and provider dry-runs; a failed preflight
leaves the run `not_run`. Provider profile selection remains authoritative and
all provisioning and retirement still pass through the Proxmox pack guards.

Two properties are non-negotiable and are enforced, not merely documented:

- **A hard public/private boundary.** All target-specific research lives in an
  external, configurable, private workspace. The public Sidekick repository is
  never the storage location for real research.
- **No special privilege.** "This is research" never bypasses a provider's
  policy, escapes the configured environment, or opens an unrestricted shell.

## What it does now vs. later

**Now (implemented and tested):** campaigns, hypotheses, scope snapshots, durable
runs (execution-backed), bounded probes — a `command` probe on the local host
(opt-in) and an `http` probe that can reach a remote/lab host under scope and
SSRF gating — evidence capture with SHA-256 integrity into the external
workspace, sanitized redaction derivatives, deterministic comparison, validation
with kernel-enforced invariants, evidence-linked report material, two governed
workflows (one of which composes `git`), and **Proxmox disposable-lab
provisioning** — a run whose environment is kind `proxmox` composes
`proxmox_provision` to create a disposable guest (recording provenance) and
`proxmox_guest` to request an authorized shutdown on cleanup.

**Deferred (clean seams, not built):** container/browser/debugger/fuzzer/packet
environment providers, a dedicated HTTP hardening tool, and disclosure
connectors. These are extension points, not present features.

## Governed Source Repository Model

The pack gives each campaign a durable logical **source repository** and one or
more immutable source snapshots. The word `repository` names the database/API
record; the private workspace directory is named `repositories`.
A source repository is campaign-owned and project-bound. It is not a second
Git authority and it does not make source content trusted.

The intended deployment example is the absolute external workspace
`/home/sidekick/sidekick-workspaces/security-research`. The actual root is
configuration-dependent (`workspace` or `SIDEKICK_RESEARCH_WORKSPACE`) and
must be outside the Sidekick repository, data directory, and managed pack
store. The campaign-centered layout is:

```text
/home/sidekick/sidekick-workspaces/security-research/
  projects/<campaign_id>/
    repositories/<repository_id>/
      <snapshot_id>/
        manifest.json
        ...copied source files...
```

The snapshot record stores a workspace-relative `storage_ref`, content hash,
file/byte/depth counts, verification metadata, lifecycle state, and the fixed
authority `derived_analysis_input`. Real targets, credentials, URLs, and
active research data must not be committed to this repository.
Every indexed result also states its source authority (`local_wsl`,
`sidekick_mirror`, or `unverified`) and source revision. These labels describe
where the lead came from; they do not promote semantic output into source
authority or a confirmed finding.

### Import and acquisition

`research_source action=import` accepts an absolute server-local directory and
copies it into a newly staged snapshot. The importer sorts entries, hashes
every regular file, writes a manifest, and atomically renames the completed
staging directory. It refuses path traversal, symlinks, special files,
hard-linked aliases, reserved `manifest.json` input, unsafe filenames, source
and destination overlap, and changes observed while copying.

`acquire` uses the canonical structured Git `clone` action. It accepts HTTPS
remotes only, rejects embedded credentials and unsafe/private destinations,
isolates Git configuration and credentials, disables hooks, helpers, filters,
submodules, and LFS smudge, resolves an optional ref to a full commit, and
copies only the verified checkout into an immutable snapshot. Remote hosts may
be constrained with `allowed_hosts`; authenticated acquisition is not exposed
until a secret-reference injection path can guarantee that secret values never
enter arguments, URLs, logs, or model context.

Configured source limits are clamped to no more than 10,000 files, 100 MiB,
depth 32, and 4,096-byte relative paths (`source_limits`). A limit violation
fails closed rather than producing a partial snapshot.

### Refresh, selection, and comparison

`refresh` verifies an existing finalized snapshot and imports its registered
directory as a **new** snapshot. It never rewrites the old snapshot or reuses
its ID. `compare` requires two distinct, currently verified snapshots in the
same campaign-owned source repository and compares their deterministic file
manifests. A stale snapshot cannot be compared, selected, or indexed.

`verify` re-reads the registered directory and compares its manifest, content
hash, file count, and byte count. Any out-of-band edit, missing manifest, or
missing directory makes the result stale. `select` only selects a finalized,
verified snapshot belonging to an active source repository. Selection is a
pointer for operator choice, not a promotion of authority: snapshots remain
`derived_analysis_input` forever.

### Semantic analysis boundary

`index` resolves the repository and snapshot IDs server-side, verifies the
snapshot, and dispatches `semantic_repo` only against that registered
snapshot directory. The returned semantic provenance must match both the
snapshot path identity and the semantic `index_root_hash`; the result is
bound back to the snapshot ID and content hash. A stale or mismatched result
fails closed. Semantic output is bounded analysis input and a discovery lead,
not the source of truth, an authorization grant, or a finding. Exact source
evidence and runtime evidence remain separate.

## Install

```text
capability action="install" name="security-research" enable=true
capability action="configure" name="security-research" config={ "workspace": "/path/to/security-research" }
capability action="health" name="security-research"
```

The pack installs **disabled** and inert until an operator points it at an
external workspace (config `workspace`, or the `SIDEKICK_RESEARCH_WORKSPACE`
environment variable). It never writes into the Sidekick repository.

## Tools

### Evidence classes and repository leads

Repository semantic results are bounded, snapshot-bound discovery leads. They
carry an index root hash, repository identity, query hash, source-relative spans,
parser fidelity, completeness and degradation metadata, and an expiring opaque
continuation cursor. A lead must be followed by an exact governed source read or
an authorized runtime probe before it supports a confirmed conclusion. Captured
research evidence uses explicit metadata classes: `discovery_lead`,
`exact_source_evidence`, `runtime_evidence`, `model_inference`, and
`unresolved_or_ambiguous`. Partial, stale, truncated, degraded, or conflicting
evidence remains unresolved and cannot satisfy the run completion invariant.

### research_status (risk `low`, alias `research_health`)

Reports readiness without exposing secrets: workspace state
(configured/missing/unsafe), availability of each composed capability, policy
switches, and configured environments.

### research_project (risk `medium`, alias `research_campaign`)

Manage durable campaigns (the project/campaign record): `create`, `get` (with
hypotheses and runs), `list`, `transition` (draft/active/paused/closed).

### research_hypothesis (risk `medium`)

Manage hypotheses and their lifecycle (proposed → ready/analysis_only → running →
supported/confirmed/rejected): `create`, `get`, `list`, `transition`. Confidence
is advisory and never a substitute for evidence.

### research_scope (risk `medium`)

Manage authorization scope snapshots and evaluate a target/operation. A scope
snapshot is the authoritative allowlist a run's probes are checked against.
`create`, `get`, `list`, `evaluate`.

### research_run (risk `high`)

Manage durable runs: `plan` (creates a platform execution + a test-run record),
`start`, `status`, `resume`, `cancel`, `complete`, `provision`, `cleanup`,
`list`. A run's state survives a restart. A completed run requires an outcome and
evidence — enforced by the kernel. For a run whose environment is kind
`proxmox`, `provision` composes `proxmox_provision` to create a disposable guest
(recording provenance as a custody artifact) and `cleanup` composes
`proxmox_guest` for an authorized shutdown, then consumes the Proxmox pack's
guarded `proxmox_retire`. Deletion is reported as pending/manual whenever the
provider denies it — `allow_destroy` off, provenance mismatch, or protection —
and the pack never issues a delete itself.

### research_probe (risk `high`)

Execute one bounded probe against a run and capture the result as an observation
with evidence. A `command` probe composes `bash` and runs on the **local host
only** — opt-in via `allow_local_probes`, and a non-local environment kind is
refused rather than silently running on the host. An `http` probe composes
`web_fetch` under scope and SSRF gating and may reach a remote/lab host. Never an
arbitrary shell.

### research_evidence (risk `medium`)

`capture`, `list`, `inspect`, `redact`. Raw evidence bytes live only in the
external workspace; the kernel stores the reference, SHA-256 hash, size and
lineage. `inspect` returns metadata only; `redact` produces a sanitized
derivative and never mutates the original.

### research_compare (risk `low`)

Deterministically compare a baseline with a candidate (status/hash/text/json),
by literal values or two evidence references. Mechanical and reproducible.

### research_validate (risk `medium`)

Validate an observation against an expectation and optionally record the run
outcome and a finding. The match verdict is deterministic; whether a mismatch is
a real issue remains a human/model judgement.

### research_report (risk `medium`)

Produce evidence-linked report material (into the workspace + a custody record),
or `get`/`list` report records. Never publishes, emails, or submits anything.

### research_source (risk `high`)

Manage campaign-owned source repositories and immutable snapshots. Actions are
`list`, `get`, `import`, `acquire`, `refresh`, `index`, `compare`, `verify`,
`select`, `archive`, `remove`, and `recover`. `recover` removes abandoned staging
directories matching the governed staging pattern; it does not infer or
recreate database records.

## Workflows

- `security-research/source-regression` (read-only) — resolve two revisions,
  produce a diffstat, and record an analysis-only hypothesis. Needs only Git;
  proves the methodology is not Proxmox-specific.
- `security-research/version-regression-check` (mutating) — against a started
  run, execute a baseline and candidate probe, capture each as evidence, and
  compare them deterministically.

Run them through the `workflow` tool:

```text
workflow action="run" name="security-research/source-regression" inputs={...}
```

## Knowledge

Three agent-facing knowledge entries ship with the pack: the operating model,
the public/private workspace boundary, and the scope/policy/probe safety model.
Find them with `knowledge action="search" query="security research"`.

## Configuration

| Key | Meaning |
|---|---|
| `workspace` | Absolute path to the external private research workspace (else `SIDEKICK_RESEARCH_WORKSPACE`). |
| `allow_local_probes` | Permit `command` probes on the Sidekick host (workdir confined to the workspace). Default `false`. |
| `probe_timeout_ms` | Default bound for a probe (default 60000). |
| `max_evidence_bytes` | Maximum size of a captured evidence artifact (default 5 MiB). |
| `http.allowed_hosts` | Host globs an HTTP probe may target when no scope snapshot is bound. |
| `http.allow_private_addresses` | Deprecated compatibility field; named outbound network scope binding is required for private HTTP targets. |
| `http.max_response_bytes` | Maximum captured HTTP response body (default 2 MiB). |
| `environments` | Named environments (`local`/`disposable`/`proxmox`/`remote`) a run may target. |
| `source_limits` | Optional import/refresh bounds: `max_files`, `max_bytes`, `max_depth`, and `max_path_bytes`; each is clamped to the safe maximums above. |

Real workspace paths, target scope and provider settings belong in ignored local
configuration, environment variables, or secret references — never in a
committed file.

## Dependencies

The module dispatches `bash` (command probes), `web_fetch` (http probes), and —
for a run with a `proxmox` environment — `proxmox_provision`, `proxmox_guest`
and the guarded `proxmox_retire` (disposable-lab provision/cleanup/retirement).
Those five are its entire permission allowlist. Its workflows additionally
compose the `git` tool through the workflow engine. None are required to install; installing the Proxmox pack is required
only to use `proxmox` environments, and `research_status` reports which
capabilities are available. A run or probe that needs an absent capability
returns a structured `dependency_missing`/`capability_unavailable` error — it
never silently falls back to an unrestricted shell.

### Disposable lab environments (Proxmox)

A `proxmox` environment is described entirely by runtime configuration — the
Proxmox pack profile (endpoint + `token_ref: secret:<name>`) and the
`proxmox_provision` spec (e.g. a clone of a template) — none of which is
committed. `research_run action=provision` clones the disposable guest and
records its identity as a custody artifact linked to the run; probes then target
it (an `http` probe reaches its address, scope-gated). `research_run
action=cleanup` requests an authorized graceful shutdown, then requests guarded
retirement through `proxmox_retire`; deletion remains pending/manual when the
provider refuses. Provider policy is never bypassed: `allow_lifecycle`,
`allow_destroy`, protected-resource and provenance controls in the Proxmox pack
still decide.

## Health

`healthy` when the workspace is configured (or intentionally unconfigured —
healthy-but-inert). An **unsafe** workspace (inside the repo/data/store) is
reported unhealthy. Health performs no network or provider call and never
resolves a secret.

## Security notes specific to this pack

- The workspace is canonicalized through `realpath` and refused if it resolves
  to, contains, or is contained by the Sidekick repository, data directory, or
  managed pack store — or if it is dangerously shallow.
- `command` probes on the Sidekick host are off by default. `http` probes refuse
  private/loopback targets by default and require a scope snapshot or an explicit
  host allowlist.
- Composed calls go through the module permission allowlist (a deny-by-default
  set of exactly the tools this pack may dispatch, each with a risk cap).
- Provider policy is never bypassed: a destructive provider operation is decided
  by that provider's controls; if cleanup is unauthorized it is reported as
  pending/manual.
- Evidence bytes never enter a tool result or model context by default —
  `inspect` returns metadata only.

## Public repository safety

The pack contains generic tooling only. Target-specific research belongs in the
external workspace. Public examples are synthetic (`example.test`,
`demo-service`, a synthetic status fixture). Local paths are configurable;
credentials are never stored in research manifests. Review staged files before
committing — the repo's static checks scan the pack surface for developer paths
and secrets, but they supplement architecture and review, they do not replace
them.

## Dashboard and API

Authenticated Dashboard views expose readiness, campaign source repositories,
snapshot details, bounded metadata, verification state, and the selected
snapshot. The current UI supports directory import, verify, select, semantic
index, archive, and remove. It does not expose arbitrary source bytes or
semantic projection content through these metadata routes.

The Dashboard API provides:

```text
GET  /api/research/source/readiness
GET  /api/research/source/repositories
GET  /api/research/source/snapshots?repository_id=<id>
GET  /api/research/source/snapshots/<snapshot_id>
GET  /api/research/source/snapshots/<snapshot_id>/verification
POST /api/research/source/actions/<action>
```

The action endpoint accepts `verify`, `select`, `index`, `compare`, `archive`,
`remove`, `recover`, and `import` (the shorter `/api/research/source/<action>`
form is also registered). Archive, remove, and recover require an
authenticated Dashboard user and explicit `confirm: true`; all calls remain
subject to normal dispatcher policy, approval, audit, project, and actor
binding. API responses redact absolute workspace paths, credentials, target
environment names, and raw semantic output.

## Archive, Removal, and Recovery Safeguards

Archiving a snapshot is allowed only from `finalized`; archiving a repository
is a separate lifecycle action. Removed snapshots are terminal. A selected
snapshot cannot be removed, so an operator must select another verified
snapshot before removal. Storage removal is verified after the database
transition and fails closed if the directory remains. The source lifecycle
does not provide an unarchive action or undelete path.

Recovery is bounded to the configured workspace's campaign `repositories` trees,
refuses symlinked roots, and deletes only abandoned directories named with the
pack's temporary staging pattern. It is cleanup of interrupted imports, not a
repair mechanism for missing manifests, database rows, or deleted snapshots.

## Synthetic Example

For a campaign `campaign_demo`, an operator may import a local synthetic
checkout:

```text
research_source action=import
  campaign_id=campaign_demo
  name=demo-service
  source_path=/tmp/demo-service
```

Sidekick creates a source repository record and finalized snapshot under
`projects/campaign_demo/repositories/<repository_id>/<snapshot_id>/`, records
`authority=derived_analysis_input`, verifies the manifest, and permits a
snapshot-bound semantic index. Editing the stored copy makes verification
return `stale`; the old snapshot cannot be selected or indexed. Refreshing
creates a second immutable snapshot, which can be compared with the first.
This example is synthetic and does not authorize a real remote, target, or
production source.

## Live-lab integration testing

The synthetic end-to-end path (`test/security-research-pack.test.js`) runs fully
offline against local command fixtures. A real Proxmox lab can be exercised by
configuring a `proxmox` environment and composing the Proxmox pack; that path is
opt-in and must remain synthetic (never point it at private active research).
Status of each layer:

```text
implemented        campaign/hypothesis/scope/run/probe/evidence/compare/validate/report, both workflows
mock/integration   synthetic end-to-end, offline, in the test suite
live-lab validated  (deferred — compose the Proxmox pack against a synthetic target)
```

## Troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| `workspace_missing` | No workspace configured | Set `workspace` or `SIDEKICK_RESEARCH_WORKSPACE`. |
| `workspace_unsafe` | Workspace resolves inside the repo/data/store or is too shallow | Point it at an external private directory. |
| `policy_denied` on a command probe | `allow_local_probes` is false | Command probes execute on the Sidekick host only and cannot be routed to a lab. Enable `allow_local_probes` for a workspace-confined synthetic fixture, or reach a provisioned lab with an `http` probe instead. |
| `scope_denied` on an http probe | Host not allowlisted / out of scope | Add the host to `http.allowed_hosts` or the campaign scope snapshot. |
| `dependency_missing` | A composed pack/tool is not installed | Install the required pack (e.g. Proxmox). |
| `state_conflict` | Illegal research state transition | Inspect the run/hypothesis state; start a new run to probe again. |

## Related documents

- `docs/capability-packs.md` — the capability-pack platform.
- `docs/proxmox-pack.md` — the Proxmox provider this pack composes for labs.
- `docs/developer-pack.md` — the Git/source capabilities this pack composes.
- `docs/artifact-custody.md` — the evidence-custody system used for integrity.
- `docs/platform-events.md` — the audit/event ledger research actions participate in.
