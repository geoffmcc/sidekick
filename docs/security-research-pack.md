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
| `http.allow_private_addresses` | Permit private/loopback HTTP targets (SSRF guard, default `false`). |
| `http.max_response_bytes` | Maximum captured HTTP response body (default 2 MiB). |
| `environments` | Named environments (`local`/`disposable`/`proxmox`/`remote`) a run may target. |

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
