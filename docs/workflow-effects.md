# Workflow effects and Agent smoke checks

Workflow `mode` remains a compact declaration: `read_only` means the workflow
does not change the inspected external target or persistent Sidekick
application state; `mutating` means it may. It is not an authorization grant
and never substitutes for the dispatcher or a caller's Agent authority
envelope.

The workflow definition, capability catalog, `workflow` list/show responses,
and Agent planner metadata also expose a derived effect summary. The summary is
computed from registered tool actions, action-specific effect metadata, input
enums/defaults, and conditional steps:

| Effect | Meaning |
| --- | --- |
| `read_only` | Bounded read that does not write a target or Sidekick state. |
| `target_read` | Inspects an external target; private access remains subject to its named scope. |
| `artifact` | Produces a bounded local/custodied artifact such as a screenshot or report file. |
| `application_state` | Persists Sidekick state such as a handoff, hypothesis, or incident record. |
| `workspace_reversible`, `build_test`, `local_process` | Changes or executes against a local workspace/process boundary. |
| `external` | May change an external target/system. |
| `unknown` | The current effect cannot be established; it cannot satisfy a strict no-write guarantee. |

Artifact creation is reported separately from target mutation and application
state. It still makes `strict_no_write` false. A workflow can therefore be
appropriate for a request that permits saved evidence but forbids changing the
inspected target. Application-state writes and external effects remain separate
from that permission.

Effect summaries include possible effects and effects enabled by defaults.
For example, `developer/repository-recon` keeps its existing
`record_handoff=true` default and reports the persistent write; supplying
`record_handoff=false` disables that step and yields a no-handoff effect
summary. The default was not changed to make the workflow appear read-only.
The API contract workflows save artifacts but only inspect their explicitly
scoped targets. `browser-automation/ui-smoke` produces a screenshot artifact;
`browser-automation/download-verification` can click a caller-selected control,
so it is classified as capable of external target change. The security
research source comparison records an analysis-only hypothesis in Sidekick.

Workflow actions are also re-evaluated at execution. An Agent authority
envelope is inherited by each workflow step and nested workflow; the dispatcher
still performs current schema, source policy, operator authorization, network
scope, and approval checks. A resumed workflow whose registered definition
checksum changed is refused so a new action or material argument cannot reuse
an earlier approval. Denied, failed, and approval-pending steps remain explicit
in step evidence and cannot become successful workflow results.

`testing-quality-engineering/quality-lifecycle` is input-dependent:

- `plan` performs verification planning (`dry_run`) without running project
  commands.
- `execute` invokes the governed project verification path and can execute
  local build/test commands.
- `cancel` reports that no cancellation handle is available and performs no
  cancellation.

Its declared mode remains `mutating` because the supported `execute` action can
run commands; the action-specific effect summary preserves the distinction.

## Offline Agent workflow smoke

Run `node scripts/agent-workflow-smoke.js <pack-path> <goal>` to inspect the
current registry without contacting a model or external service. The report
separates workflow dependency resolution, discovery/ranking against the full
Agent-source catalog, action availability, and dispatch. Offline dispatch is
always `not_run`; metadata checks never claim that a workflow executed. The
resolver uses registered workflow records, the canonical registry (including
authoritative aliases), actual enabled/available capability state, and
`getToolDefsForSource("agent")`. `--live` is a distinct optional Agent Bridge
task execution check.

The focused Agent/workflow fixtures cover core and cross-pack dependencies,
disabled/missing tools, synthetic registered capabilities, full-catalog
ranking, authorization denial, approval-pending and partial-failure evidence,
definition drift, and actual bounded artifact custody where the browser fixture
is available. Scripted model decisions in Agent-loop tests establish protocol
and dispatch plumbing, not real-model planning reliability. No production Agent
task was run as part of the repository checks; deployed Agent reliability
remains unmeasured.
