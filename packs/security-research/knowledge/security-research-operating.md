# Security Research pack: operating model and tools

The Security Research pack is a governed orchestration layer for authorized
security research. It composes existing Sidekick capabilities rather than
reimplementing them, and it keeps all target-specific research in an external,
private workspace — never in the Sidekick repository.

## What it is

- A durable, auditable research state machine built on the platform kernel's
  existing research record layer (campaigns, hypotheses, runs, findings,
  reports).
- A capability *consumer*: command probes dispatch `bash`, http probes dispatch
  `web_fetch`, a `proxmox` environment composes `proxmox_provision`/
  `proxmox_guest` to provision and tear down a disposable lab, and its workflows
  compose `git` — all through the normal policy/approval/audit path. It has no
  special privilege and cannot bypass provider policy.

## What it is not

- Not an unrestricted shell. There is no "run anything anywhere" primitive.
- Not a disclosure system. It never publishes, emails, or submits reports.
- Not a store for real research. Evidence and reports live in the external
  workspace; Sidekick keeps references, hashes and lineage.

## Tools

| Tool | Purpose |
|---|---|
| `research_status` | Readiness: workspace state, composed-capability availability, policy switches. |
| `research_project` | Durable campaigns (create/get/list/transition). |
| `research_hypothesis` | Hypotheses and their lifecycle. |
| `research_scope` | Authorization scope snapshots; evaluate target/operation. |
| `research_run` | Durable runs (plan/start/status/resume/cancel/complete). |
| `research_probe` | One bounded, typed, scope-gated probe (command or http) → observation + evidence. |
| `research_evidence` | Capture/list/inspect/redact evidence (bytes stay in the workspace). |
| `research_compare` | Deterministic baseline-vs-candidate comparison. |
| `research_validate` | Expected-vs-observed verdict; optional run outcome and finding. |
| `research_report` | Evidence-linked report material into the workspace. |

## A typical run

1. `research_project action=create` — a campaign, optionally with a scope snapshot.
2. `research_hypothesis action=create` — the claim under investigation.
3. `research_scope action=create` — the authorized targets/operations.
4. `research_run action=plan` then `action=start` — a durable run in an environment.
5. `research_probe` — capture a baseline observation, then a candidate observation.
6. `research_compare` — deterministic delta.
7. `research_validate` — record the outcome (and a finding if warranted).
8. `research_report action=materialize` — evidence-linked report material.

## Deterministic vs. model-assisted

Hashing, comparison, scope checks, state tracking and evidence association are
decided by code and work with no model at all. A model may help formulate
hypotheses or interpret results, but interpretation is kept distinct from the
raw observations and never overwrites them.
