# Brain v3 foundation

Brain v3 is the structured-reasoning foundation used by Sidekick's durable
Agent task path. It adds bounded task understanding and observability around
the existing Agent Bridge, Compute Placement, dispatcher, memory, approval,
and verification systems. It does **not** create a second execution authority:
tool effects still go through the canonical dispatcher.

The current flow is:

```text
request
 → versioned TaskSpec compilation (or deterministic fallback)
 → scoped context and evidence planning
 → deterministic plan validation
 → independent plan critique
 → governed tool execution and evidence collection
 → belief/trace checkpoints
 → verification and synthesis
 → durable task and control-room projections
```

## Scope and compatibility

Brain v3 is a foundation, not an unbounded autonomous loop, a dispatcher or
Compute replacement, self-modifying code, or an approval bypass. Its new
records are bounded projections: raw prompts, model chain-of-thought, secrets,
and unredacted tool output are not stored in the Brain v3 tables.

The durable Agent path uses Brain unless `SIDEKICK_BRAIN_ENABLED` is explicitly
set to a false value; `1` and `true` explicitly enable it. In non-test runtime,
an unset flag leaves the durable Brain path enabled. Test mode preserves the
explicit-flag behavior for deterministic tests. Disabling the path retains the
older Agent routing compatibility behavior and is the rollback switch for the
Brain execution branch. Approval continuation and recovery remain governed by
the existing durable task and approval contracts; see
[`adr-approval-continuation.md`](adr-approval-continuation.md).

Historical references to **Brain v0.1** in the ADR, source comments, and
compatibility tests describe the original bounded planner contract. They do
not describe the current production-wide Brain version.

## TaskSpec compilation and revisions

`src/brain/task-spec.js` normalizes an objective into a version-3 TaskSpec.
It includes the original and normalized objective, deliverables,
requirements, success criteria, constraints, preferences, prohibited actions,
assumptions, ambiguities, clarifications, evidence and verification
requirements, dependencies, stopping conditions, authority boundary, live
evidence/read-only/change flags, and preferred execution profile.

Compilation is deterministic and fail-closed:

- forbidden prototype-pollution keys and model-asserted authority fields are
  rejected at any nesting level;
- text, list, depth, and item counts are bounded and prompt-injection markers
  are rejected;
- conflicting requirements are rejected;
- an invalid or conflicting input produces a bounded fallback TaskSpec with a
  stopping condition requiring an explicit validated specification. The
  fallback is not permission to execute the rejected intent.

Every durable task invocation persists the validated compiled spec, or the
deterministic fallback, in `brain_task_spec_revisions`. Revisions are numbered
per task and retain the source (`compiled` or `deterministic_fallback`), spec
identifier, bounded JSON, and timestamp. The runtime revalidates a spec before
persistence; stored data is a record, not an authority grant.

## Belief snapshots

`src/brain/belief-state.js` provides a version-3, immutable-style belief state
projection. It tracks bounded hypotheses, evidence references, contradictions,
required-evidence coverage, progress, and one of these states:

`intake`, `active`, `blocked`, `stalled`, `complete`, or `contradicted`.

Transitions are explicit and terminal states cannot transition back. Evidence
can support, contradict, or neutrally relate to a hypothesis. Coverage reports
supported and missing requirements; repeated progress-free assessment can mark
a task stalled, and contradictions can make it contradicted.

The Agent runtime checkpoints this state in `brain_belief_snapshots` during
task progress and completion. The latest snapshot is available in the task
and control-room Brain v3 projections.

## Cognitive traces and metrics

`src/brain/cognitive-trace.js` records bounded operational events, not private
reasoning. Events are capped at 256 with bounded fields and payloads. Trace
redaction removes secret-like values, authority fields, forbidden keys, and
over-deep data before persistence. Finalized traces aggregate deterministic
metrics such as event counts, durations, tokens, tool calls, and revisions.

The runtime stores traces in `brain_cognitive_traces` and metrics in
`brain_cognitive_metrics`. These are diagnostic projections; they must not be
treated as a transcript of chain-of-thought or as an authorization record.

## Planning and the independent critic

The planner still emits the small legacy JSON plan shape (version 1, bounded
steps, and a final synthesis step). `plan-validator.js` independently checks
that shape before any step executes. It rejects malformed, cyclic, oversized,
unknown, or unauthorized-looking plans; it does not trust model-supplied risk,
approval, provenance, trust, or verification fields. The live dispatcher
rechecks schema, policy, approval, redaction, and audit requirements for every
call.

After deterministic validation, `src/brain/critic.js` performs an independent
deterministic critique. It can require revision when a plan has no steps, when
live evidence is required but no tool step exists, or when a read-only TaskSpec
contains a mutating effect. A `revise` result returns bounded feedback to the
planner; the critic does not execute tools and cannot authorize a plan.

All tool steps use `callAgentTool` through the Agent Bridge. Compute is
requested by logical capability (`embeddings`, `chat`, or `generate`); provider,
model, worker, executor, and accelerator placement remains a Compute concern.

## Evidence graph and verification compiler

`src/brain/evidence-graph.js` is a deterministic, bounded evidence graph. It
accepts governed references and typed nodes for objectives, deliverables,
requirements, claims, evidence, verification, artifacts, receipts, and memory.
Supported relations include `supports`, `contradicts`, `satisfies`, `verifies`,
`produces`, `references`, and `derived_from`. It rejects unknown references,
unknown nodes, and graph bounds violations. Its coverage function classifies a
requirement as `supported`, `contradicted`, or `unverified` and returns bounded
evidence references.

`src/brain/verification-compiler.js` deterministically turns TaskSpec success
criteria and verification requirements into bounded verification gates. It
labels each gate as requiring `fresh_authoritative` or `bounded_support`
evidence and reports available read-only capabilities and mutation count.

Both modules are exported through `src/brain/index.js` as Brain v3 foundation
components. The live Agent completion path continues to use the established
durable receipt/recipe verification gates and fresh read-only repair path; the
verification compiler and evidence graph are not yet the sole authoritative
completion implementation.

## Durable task and control-room projection

The Agent service runs migration `075_brain_v3_foundations.sql`, creating:

- `brain_task_spec_revisions`
- `brain_belief_snapshots`
- `brain_cognitive_traces`
- `brain_cognitive_metrics`

The authenticated routes `GET /api/agent/tasks/:taskId` and
`GET /api/agent/tasks/:taskId/control-room` include an additive `brain_v3`
object containing bounded task-spec revisions, the latest belief snapshot, and
recent traces. The control-room route is a durable read projection; its
`source` is `durable_task_store`. Task access checks still apply, and the
projection does not turn stored model or tool text into authority.

The transcript also carries additive Brain v3 metadata (`brain.version`, task
spec revision marker, belief status, and requirement coverage), alongside the
existing redacted Brain state and evidence count. It remains compatible with
older transcript readers.

## Configuration and migration

- `SIDEKICK_BRAIN_ENABLED=1` or `true` explicitly enables Brain; an explicitly
  false value disables the branch. Do not rely on the old “off by default”
  description for durable tasks.
- Security-relevant Brain bounds are frozen in `BRAIN_LIMITS`; they are not
  environment-overridable. They include 12 plan steps, 2 planning attempts,
  180 seconds total task time, 60 seconds per tool step, 120 seconds per
  generation request, bounded memory/evidence, and bounded output tokens.
- Apply normal pending migrations at Agent startup. Migration 075 is additive
  (`CREATE TABLE IF NOT EXISTS` plus indexes) and has no destructive operation.
- Profiles (`quick`, `standard`, `deep`, `persistent`, and `research`) shape
  the durable Agent iteration/replanning budget and planning guidance; they do
  not grant authority or widen the frozen Brain limits.

## Approval, recovery, and security guarantees

A dispatcher result requiring approval parks the task in
`waiting_for_approval`; Brain never retries or bypasses that approval. With
the durable continuation seam, the plan, evidence, counters, identity
lineage, and deadline are checkpointed atomically with the approval. Approval
or denial wakes the same task, and the resumed answer is written to its
transcript. `SIDEKICK_SECRET_KEY` is required to resume parked work; rotating
it can strand parked tasks, so drain or explicitly fail them first.

The approval sweeper (`SIDEKICK_APPROVAL_SWEEP_INTERVAL_MS`, default 60s) and
resume scheduler (`SIDEKICK_BRAIN_RESUME_INTERVAL_MS`, default 5s) are Brain-
gated background jobs. Monitor their structured sweep counts before disabling
Brain with parked work. Ambiguous high-risk execution is placed in
`reconciling` and is not automatically redispatched; an authenticated human
must resolve it through the reconciliation flow.

Terminal task states are sticky. Late tool or compute results cannot resurrect
a cancelled or timed-out task, and ambiguous side effects are not replayed
automatically. Every effect remains subject to current identity, project and
workspace scope, policy, schema, approval, redaction, and audit checks.
Untrusted goals, memory, provider output, and tool output are data rather than
instructions and cannot add a step after validation.

## Limitations

- Compute calls have a timeout ceiling but no proactive cancellation; a timed-
  out task can retain a provider socket until that ceiling, although late
  results are discarded.
- Evidence classification remains heuristic; the completion verifier and
  durable verification gates are the guarantee for live-state honesty.
- Regex-based redaction can miss novel secret formats.
- The evidence graph and verification compiler are foundation APIs, not yet a
  replacement for the existing receipt/recipe completion authority.
- Brain v3 projections are bounded and intentionally omit chain-of-thought and
  raw sensitive payloads; they cannot independently reconstruct every detail
  of a task execution.

## Deterministic benchmark

`npm run test:brain-v3` includes the versioned
`sidekick.brain-v3-benchmark.v1` evaluator. It uses bounded fixture planner,
tool, memory, and synthesizer seams and therefore reports
`provider_integration: not_evaluated`; it does not claim success for an
unavailable local model or a live Agent process. The 15-scenario matrix covers
direct answers, fresh evidence, missing evidence honesty, malformed plans,
unavailable tools, critic replanning, cancellation, deadline handling,
ambiguous goals, authority denial, partial completion, conflicting evidence,
false initial beliefs, bounded memory retrieval, and excessive/circular tool
use. Results include terminal correctness, verified completion, unsupported
completion, tool selection, prerequisite detection, recovery, authority and
partial-completion observations, replans, intervention, and latency. Memory
selection and semantic conflict detection remain explicitly `not_evaluated`:
the deterministic harness records bounded memory flow and conflicting fixture
observations but does not pretend to evaluate model judgment or live results.

## Testing and manual checks

Run the focused foundation and deterministic behavior checks:

```bash
npm run test:brain-v3
```

This runs `test/brain-v3-foundations.test.js` and
`scripts/evaluate-brain-v3.js`. For the repository documentation drift check:

```bash
npm run check:docs
```

For a manual control-room check, submit a durable Agent task, then request
`GET /api/agent/tasks/<task-id>/control-room` with the same authenticated
project/task context. Confirm `brain_v3.task_specs`, `brain_v3.belief`, and
`brain_v3.traces` are present, and inspect the durable task state rather than
treating the transient SSE stream as authoritative.
