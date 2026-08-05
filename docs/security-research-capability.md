# Security Research Capability

Status: Proposed capability-pack architecture
Verified commit: d2db2658ef0fbf862c64b09315279562caa5bb8e
Verified date: 2026-08-05T16:16:46-04:00

## Position And Responsibility

`@sidekick/security-research` is a future module, not Sidekick core and not an unrestricted autonomous offensive-security system. Sidekick owns project/campaign control, authorization snapshots, scope enforcement, orchestration, approvals, execution lineage, evidence custody, artifacts, monitoring, correspondence metadata, handoffs and compute routing. The separate Security Research Workbench owns structured investigations, hypotheses, claim analysis, adversarial validation and report-oriented output. Coding agents review code/tests but do not own state. Disposable labs reproduce behavior; authoritative state and evidence stay outside them. Humans decide authorization, destructive actions, findings, reports, submissions and disclosure.

## Domain Mapping

| Concept | Classification | Mapping |
|---|---|---|
| SecurityResearchProject, Program | Extension | Project Runtime and program metadata, not a second project store. |
| ScopeSnapshot | Extension | Versioned artifact/policy record bound to every action. |
| Target, Asset, VersionRecord | Extension | Project/workspace and connector references. |
| Campaign, Hypothesis, Dependency | Extension | Workflow/memory-linked investigation records, including rejected results. |
| TestEnvironment, TestRun | Extension plus generic | Workspace/connector plus platform Execution. |
| Observation, ControlTest | Extension | Execution results linked to evidence, not agent prose. |
| EvidenceArtifact, Derivative | Generic plus extension metadata | `platform_artifacts`, immutable originals and lineage. |
| Finding, ImpactClaim, SourceReference | Extension | Claims cite runs, artifacts, versions and human judgment. |
| Report, Correspondence, Retest, Disclosure | Extension | Artifact/report lifecycle and approval-gated communication. |

## Scope Guard And Confirmation

Scope Guard attaches immediately before centralized dispatch. It evaluates target, operation, technique, tool/connector, environment, program restrictions, rate limit, third-party data risk, privilege, project/campaign and the exact current ScopeSnapshot. The module check adds domain context but is never the only enforcement boundary. Every execution stores the snapshot ID and digest.

Hypotheses retain claim, boundary, rationale, prerequisites, environment, expected secure/vulnerable behavior, controls, criteria, observations, evidence, rejection reason and confidence. States remain distinct: `proposed`, `ready`, `blocked`, `analysis_only`, `not_run`, `running`, `inconclusive`, `rejected`, `supported`, `confirmed`.

`confirmed` requires a qualifying execution, test environment, observed behavior, controls, evidence and completion validation. Workbench/model output without execution and evidence remains `analysis_only` or `not_run`.

```text
analysis_completed -> test_designed -> environment_prepared -> test_executed
-> result_observed -> control_executed -> evidence_captured -> result_confirmed
```

## Evidence, Disclosure And Lab Safety

Use generic artifact registration for custody. Originals include digest, size, timestamp, source, environment, method, execution ID, sensitivity, retention and custody events. Redacted/report-safe files are derivatives and never replace originals. Outgoing vendor correspondence/submissions require human approval. Disclosure may progress through draft, internal review, ready, submitted, acknowledged, triage, duplicate/informative, accepted, remediation, resolved, retest, bounty and closed states.

Lab policy is represented by environment records, connector configuration and policy, not hard-coded VLANs or addresses. Disposable targets have no route to household/production systems; destructive actions require approval and clean snapshots; evidence is exported before target destruction.

## Testing

Cover descriptor/registry ownership, scope denial, snapshot binding, approval/reconciliation, execution/artifact lineage, digest/derivative immutability, Workbench truthfulness, lab connector isolation, claim-evidence coverage, disclosure authorization, retention and replay safety. Integration tests use disposable fixtures and never contact unauthorized targets.
