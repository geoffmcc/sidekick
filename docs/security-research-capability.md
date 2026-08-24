# Security Research Capability

Status: Shipped governed capability pack; optional runtime configuration is required

Implementation reality: the generic kernel records exist
(scope snapshots/guard, campaigns, hypotheses, test runs, findings, reports,
disclosure gates — migrations 032–035), and the shipped `packs/security-research`
pack exposes them through governed tools and workflows. The pack enforces
scope, policy, approval, audit, evidence-integrity and external-workspace
boundaries. Command probes dispatch the governed `bash` tool, HTTP probes
dispatch `web_fetch`, workflows compose the governed Git tool, and a configured
Proxmox environment can compose the governed provisioning/guest tools. No
private research workspace or target data is part of this repository. All
fixtures are synthetic.

## Governed Source Repository And Snapshot Lifecycle

The Security Research source model is campaign-centered and lives in the
configured absolute external workspace. A deployment may use
`/home/sidekick/sidekick-workspaces/security-research` as its workspace
example, but the configured path is authoritative and is never assumed. The
 layout is `projects/<campaign_id>/repositories/<repository_id>/<snapshot_id>/`.
 `repositories` is the actual directory name; there is no parallel
storage layout. The logical source repository is a project-bound,
campaign-owned database record with immutable snapshots beneath it.

Directory `import` is implemented. It copies only a complete, bounded tree of
regular files into external storage and records a deterministic manifest. The
safe bounds are at most 10,000 files, 100 MiB, depth 32, and 4,096-byte
relative paths, with configured values clamped to those maxima. Traversal,
symlinks, special files, hard-linked aliases, unsafe names, source/destination
overlap, and read-time changes are rejected. Staging is atomic from the
workspace perspective, and failed imports clean up their temporary directory.

Git `acquire` is intentionally fail-closed and currently unsupported. The
registered Git surface has no safe clone/fetch action, so no shell command or
network operation is attempted. Importing an operator-created local checkout
is supported; arbitrary remote acquisition, credentials, ref fetching, and
automatic clone management are not.

`refresh` verifies and copies a finalized registered snapshot into a new
snapshot. It never mutates or reuses the prior snapshot. `verify` detects
out-of-band changes as `stale`; stale snapshots cannot be selected, compared,
or indexed. `select` updates the active repository's selected snapshot only
after verification. All snapshots retain `authority=derived_analysis_input`;
integrity, selection, or indexing never promotes source content to Sidekick
authority.

The semantic bridge accepts repository and snapshot identifiers, not an
arbitrary analysis path. It verifies the snapshot, dispatches the bounded
`semantic_repo` capability against the registered directory, and requires
matching repository-path identity and `index_root_hash` provenance. The index
is therefore snapshot-bound. Its output remains untrusted analysis input and
a `discovery_lead`; exact source and runtime evidence are required for
authoritative conclusions.

The source lifecycle persists repository and snapshot identity in the platform
kernel (migration 065) and records campaign/project ownership, state, hashes,
counts, storage references, verification, authority, and lifecycle timestamps.
It supports list/get/import/acquire/refresh/index/compare/verify/select/archive/
remove/recover through the `research_source` tool. Archive is restricted to
valid lifecycle transitions. Removal requires a snapshot, refuses a snapshot
still selected by its repository, removes the external copy, and verifies that
storage is gone. Recovery removes only abandoned, bounded staging directories;
it does not invent records or restore deleted data.

## Position And Responsibility

`@sidekick/security-research` is an optional module, not Sidekick core and not an unrestricted autonomous offensive-security system. The separate Security Research Workbench is not a prerequisite: the shipped pack is the current operator surface, and its composed tools remain subject to the normal policy, approval and audit path. A Workbench adapter remains an optional future replacement or additional consumer, not the source of current truth.

Sidekick owns project/campaign control, authorization snapshots, scope enforcement, orchestration, approvals, execution lineage, evidence custody, artifacts, monitoring, correspondence metadata, handoffs and compute routing. The current `security-research` surface owns whatever investigation/report workflow is verified for the deployment; its state must be integrated through APIs, connectors or events rather than private shared tables. Coding agents review code/tests but do not own state. Disposable labs reproduce behavior; authoritative state and evidence stay outside them. Humans decide authorization, destructive actions, findings, reports, submissions and disclosure.

## Domain Mapping

| Concept | Classification | Mapping |
|---|---|---|
| SecurityResearchProject, Program | Extension | Project Runtime and program metadata, not a second project store. |
| ScopeSnapshot | Extension | Versioned artifact/policy record bound to every action. |
| Target, Asset, VersionRecord | Extension | Project/workspace and connector references. |
| Campaign, Hypothesis, Dependency | Extension | Workflow/memory-linked investigation records, including rejected results; map the current `security-research` workflow before designing Workbench-specific entities. |
| TestEnvironment, TestRun | Extension plus generic | Workspace/connector plus platform Execution. |
| Observation, ControlTest | Extension | Execution results linked to evidence, not agent prose. |
| EvidenceArtifact, Derivative | Generic plus extension metadata | `platform_artifacts`, immutable originals and lineage. |
| Finding, ImpactClaim, SourceReference | Extension | Claims cite runs, artifacts, versions and human judgment. |
| Report, Correspondence, Retest, Disclosure | Extension | Artifact/report lifecycle and approval-gated communication. |

## Scope Guard And Confirmation

Scope Guard is enforced by the security-research module before its composed probes and lab operations reach centralized dispatch. The generic versioned snapshot, target-digest, operation allowlist, fail-closed decision, and execution-binding contract are documented in `docs/security-research-scope-guard.md`. Domain evaluation adds target, technique, tool/connector, environment, program restrictions, rate limit, third-party data risk, privilege, project/campaign and the exact current ScopeSnapshot. The module check is never the only enforcement boundary. Every bound execution stores the snapshot and decision digests.

Phase 7 now provides bounded campaign, hypothesis and test-run records. Campaigns are project-bound and may carry the current scope snapshot; hypotheses belong to a campaign and preserve claim, rationale, prerequisites, criteria and confidence; test runs link a hypothesis to an optional platform execution, scope snapshot, environment and evidence references. These records are workflow metadata, not an execution engine or finding store.

Evidence-linked findings and report metadata are also bounded references. Findings default to `analysis_only`; `confirmed` requires a completed test run and evidence references. Reports reference findings and, optionally, a generic immutable artifact. Neither record embeds evidence bytes or sensitive capture content.

Disclosure metadata is human-gated and stores only report/artifact references, opaque recipient and approval references, state, and timestamps. Submission requires an explicit approval reference; correspondence bodies and recipient addresses are intentionally outside this ledger.

The final Phase 7 lab policy is fail-closed: only explicitly disposable, isolated environments with `none` or fixture-only networking and `production_access: false` pass. Destructive operations require approval, and operations requiring snapshots must present one. The policy module evaluates descriptors only; it does not discover or connect to networks.

Phase 8 evaluation/replay begins with an audit-only foundation. Replay records contain deterministic digests over opaque execution/event/artifact references and observations; they expose no action list and cannot dispatch tools or mutate execution state.

Hypotheses retain claim, boundary, rationale, prerequisites, environment, expected secure/vulnerable behavior, controls, criteria, observations, evidence, rejection reason and confidence. States remain distinct: `proposed`, `ready`, `blocked`, `analysis_only`, `not_run`, `running`, `inconclusive`, `rejected`, `supported`, `confirmed`.

`confirmed` requires a qualifying execution, test environment, observed behavior, controls, evidence and completion validation. Workbench/model output without execution and evidence remains `analysis_only` or `not_run`.

```text
analysis_completed -> test_designed -> environment_prepared -> test_executed
-> result_observed -> control_executed -> evidence_captured -> result_confirmed
```

## Evidence, Disclosure And Lab Safety

Use generic artifact registration for custody. Originals include a SHA-256 digest, size, timestamp, source, environment, method, execution ID, sensitivity, retention and custody events. Redacted/report-safe files are explicit derivatives linked to an existing original and never replace it. The dashboard exposes bounded custody metadata without unrestricted artifact reads. Outgoing vendor correspondence/submissions require human approval. Disclosure may progress through draft, internal review, ready, submitted, acknowledged, triage, duplicate/informative, accepted, remediation, resolved, retest, bounty and closed states.

The generic connector contract owns registration, configuration, lifecycle, opaque secret references, health and event metadata. The shipped pack does not embed a Workbench transport or bypass provider APIs: it composes the governed local tools and optional configured lab providers. Do not claim Workbench-backed integration until its endpoint, lifecycle and result contract are separately verified.

Lab policy is represented by environment records, connector configuration and policy, not hard-coded VLANs or addresses. Disposable targets have no route to household/production systems; destructive actions require approval and clean snapshots; evidence is exported before target destruction.

### Evidence classes from the shared evidence contract

The source and semantic paths use the evidence classes introduced by the shared
evidence model:

| Class | Meaning |
|---|---|
| `discovery_lead` | Bounded semantic or repository discovery that points to a location for follow-up. |
| `exact_source_evidence` | Evidence tied to an exact governed source read and source span/content. |
| `runtime_evidence` | An observation captured from an authorized execution or probe. |
| `model_inference` | A model-generated interpretation, never proof by itself. |
| `unresolved_or_ambiguous` | Partial, stale, truncated, degraded, conflicting, or otherwise unresolved material. |

Only complete, non-stale, non-truncated, non-degraded, non-conflicting
evidence outside `discovery_lead` and `model_inference` can satisfy the shared
authoritative-completion gate. Evidence class is trust metadata, not an
authority grant and cannot override scope, policy, or approval.

## Dashboard/API Surface And Recovery

Authenticated Dashboard routes expose readiness and bounded repository/snapshot
metadata:

```text
GET  /api/research/source/readiness
GET  /api/research/source/repositories
GET  /api/research/source/snapshots
GET  /api/research/source/snapshots/:snapshotId
GET  /api/research/source/snapshots/:snapshotId/verification
POST /api/research/source/actions/:action
```

The Dashboard UI currently offers readiness, import, details, verify, select,
index, archive, and remove. API actions additionally cover compare and recover;
acquire and refresh remain tool-level operations, with acquire unsupported and
refresh requiring an existing finalized snapshot. Destructive API actions
require an authenticated user and explicit confirmation. Responses expose
bounded metadata only and do not expose absolute workspace paths, credentials,
raw evidence, or raw semantic projections.

## Threat Model, Backup, And Rollback

Source paths, filenames, file contents, manifests, Git metadata, refs, URLs,
and model output are untrusted. The boundaries address path traversal, source
and destination races, symlink/hard-link/special-file substitution, partial
imports, stale or mismatched indexes, cross-campaign/project access, authority
confusion, prompt injection, unapproved mutation, and accidental deletion.
The filesystem copy and kernel state update are not one database transaction;
postconditions and recovery are therefore explicit, and interrupted staging
directories are the only automatically recoverable residue.

The external workspace is application data and must be covered by the
operator's private Sidekick deployment backups. Back up the workspace together
with the Sidekick database before migrations or lifecycle cleanup when source
recovery matters. A database restore alone cannot recreate missing external
snapshot bytes; a workspace restore alone cannot recreate kernel metadata.
Rollback is by restoring the matching database/workspace backup pair or by
selecting a still-verified older immutable snapshot. There is no claim of
Git-remote rollback, automatic unarchive, or undelete.

## Testing

Cover descriptor/registry ownership, scope denial, snapshot binding, approval/reconciliation, execution/artifact lineage, digest/derivative immutability, `security-research` result truthfulness, optional Workbench adapter behavior, lab connector isolation, claim-evidence coverage, disclosure authorization, retention and replay safety. Integration tests use disposable fixtures and never contact unauthorized targets.
