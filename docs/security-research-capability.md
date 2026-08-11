# Security Research Capability

Status: Proposed capability-pack architecture
Verified commit: d2db2658ef0fbf862c64b09315279562caa5bb8e
Verified date: 2026-08-05T16:16:46-04:00

## Position And Responsibility

`@sidekick/security-research` is a future module, not Sidekick core and not an unrestricted autonomous offensive-security system. This audit does **not** assume that the separate Security Research Workbench is operational: it currently is not working, so it must not be a prerequisite for the capability-pack roadmap. The present operator workflow uses `security-research`; the first integration should target that working surface through a documented, typed boundary. A Workbench adapter remains an optional future replacement or additional consumer, not the source of current truth.

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

Scope Guard attaches immediately before centralized dispatch. Phase 7 now provides the generic versioned snapshot, target-digest, operation allowlist, fail-closed decision, and execution-binding contract in `docs/security-research-scope-guard.md`. Domain evaluation still adds target, technique, tool/connector, environment, program restrictions, rate limit, third-party data risk, privilege, project/campaign and the exact current ScopeSnapshot. The module check is never the only enforcement boundary. Every bound execution stores the snapshot and decision digests.

Phase 7 now provides bounded campaign, hypothesis and test-run records. Campaigns are project-bound and may carry the current scope snapshot; hypotheses belong to a campaign and preserve claim, rationale, prerequisites, criteria and confidence; test runs link a hypothesis to an optional platform execution, scope snapshot, environment and evidence references. These records are workflow metadata, not an execution engine or finding store.

Hypotheses retain claim, boundary, rationale, prerequisites, environment, expected secure/vulnerable behavior, controls, criteria, observations, evidence, rejection reason and confidence. States remain distinct: `proposed`, `ready`, `blocked`, `analysis_only`, `not_run`, `running`, `inconclusive`, `rejected`, `supported`, `confirmed`.

`confirmed` requires a qualifying execution, test environment, observed behavior, controls, evidence and completion validation. Workbench/model output without execution and evidence remains `analysis_only` or `not_run`.

```text
analysis_completed -> test_designed -> environment_prepared -> test_executed
-> result_observed -> control_executed -> evidence_captured -> result_confirmed
```

## Evidence, Disclosure And Lab Safety

Use generic artifact registration for custody. Originals include a SHA-256 digest, size, timestamp, source, environment, method, execution ID, sensitivity, retention and custody events. Redacted/report-safe files are explicit derivatives linked to an existing original and never replace it. The dashboard exposes bounded custody metadata without unrestricted artifact reads. Outgoing vendor correspondence/submissions require human approval. Disclosure may progress through draft, internal review, ready, submitted, acknowledged, triage, duplicate/informative, accepted, remediation, resolved, retest, bounty and closed states.

The generic connector contract owns registration, configuration, lifecycle, opaque secret references, health and event metadata. Phase 6 provides a fail-closed typed adapter boundary in `docs/security-research-adapter-contract.md`; the repository currently has no verified `security-research` API transport. The first domain connector must be defined against a working surface and tested independently of the unavailable Workbench. Do not claim Workbench-backed integration until its endpoint, lifecycle and result contract are verified.

Lab policy is represented by environment records, connector configuration and policy, not hard-coded VLANs or addresses. Disposable targets have no route to household/production systems; destructive actions require approval and clean snapshots; evidence is exported before target destruction.

## Testing

Cover descriptor/registry ownership, scope denial, snapshot binding, approval/reconciliation, execution/artifact lineage, digest/derivative immutability, `security-research` result truthfulness, optional Workbench adapter behavior, lab connector isolation, claim-evidence coverage, disclosure authorization, retention and replay safety. Integration tests use disposable fixtures and never contact unauthorized targets.
