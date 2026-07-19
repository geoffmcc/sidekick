# Brain v0.1

Brain v0.1 is a small, bounded, feature-flagged orchestration layer on top of
the Agent Bridge, Compute Placement, the tool dispatcher, and the existing
memory and approval systems. It coordinates a single request end to end:

```text
understand request
→ classify evidence requirement (reuse agent-protocol classifier)
→ retrieve relevant scoped memory (embeddings via Compute Placement)
→ produce a bounded STRUCTURED plan (LLM, generation via Compute Placement)
→ validate the plan DETERMINISTICALLY (a model never validates its own plan)
→ execute approved steps through the dispatcher (callAgentTool)
→ collect evidence
→ verify required evidence exists
→ synthesize the final answer
```

## Non-goals

Brain v0.1 is **not** an unbounded agent loop, a dispatcher replacement, a
Compute replacement, self-modifying code, an automatic tool generator, or a way
to bypass approvals. It plans within hard bounds and fails closed.

## Feature flag and rollback

Brain is **off by default**. It is enabled by `SIDEKICK_BRAIN_ENABLED=1`.

- **Disabled (default):** `runAgent` in `src/agent.js` behaves exactly as
  before — the Brain branch is skipped entirely and the Agent Bridge uses its
  existing direct-answer / tool-loop routing. The Brain module is loaded with a
  guarded `require`, so even a Brain load error cannot affect the disabled path.
- **Rollback:** unset the flag (or revert the single commit). No schema or data
  migration is involved; disabling is instant and total.

Enablement, default state, and rollback are covered by
`test/brain-integration.test.js`, which asserts the disabled path preserves the
prior routing, transcript shape, and step shape.

## Architecture

Focused modules under `src/brain/`:

- `config.js` — the feature flag plus `BRAIN_LIMITS`. Security-relevant bounds
  are frozen and **not** environment-overridable (mirroring
  `agent-continuation`'s `CONTINUATION_LIMITS`), so a bounded planner cannot be
  silently widened into an unbounded loop.
- `plan-validator.js` — the pure, deterministic validator (the trust boundary).
- `brain.js` — the orchestrator. Pure and dependency-injected (LLM planner,
  `callTool`, memory recall, synthesize, clock, cancel), so the lifecycle,
  evidence gate, and honesty behavior are testable without a server or model.
- `index.js` — production wiring: builds the LLM-backed planner/synthesizer
  around the injected `callLLM` (→ Compute Placement) and layers untrusted
  material into prompts safely.

Integration lives in `src/agent.js` `runAgent`: a single early branch delegates
to Brain when the flag is on.

## Plan and deterministic validation

The planner produces a strict JSON plan:

```json
{
  "version": 1,
  "goal": "Check current disk usage",
  "steps": [
    { "id": "step-1", "type": "memory_retrieval", "capability": "embeddings", "purpose": "..." },
    { "id": "step-2", "type": "tool", "tool": "health", "arguments": {}, "purpose": "..." },
    { "id": "step-3", "type": "synthesis", "depends_on": ["step-1", "step-2"] }
  ]
}
```

`validatePlan` runs **before any step executes** and rejects the whole plan on
any failure. A model never validates its own plan — the validator is a separate
pure function with no model call. Benign unknown plan/step fields (`thoughts`,
`status`, …) — which small local models routinely emit despite schema-only
prompting — are **stripped and reported** (`stripped` in the result and in the
`brain.plan_validated` event) rather than fatal; the validated plan is rebuilt
exclusively from whitelisted fields, so a stripped key can never reach
execution. Everything else rejects:

- non-object plans
- prototype-pollution-shaped keys (`__proto__`, `constructor`, `prototype`)
  anywhere in the plan, a step, or step arguments
- **model-asserted authority fields** — `risk`, `approved`/`approval`,
  `trust_level`, `verified`, `provenance`, `source`, etc. Risk, approval, and
  classification are computed server-side by policy/approval/placement and are
  never taken from the model
- unsupported version; unknown step type (only `memory_retrieval`, `tool`,
  `synthesis`); unknown capability name
- a `tool` step naming a tool that is not present in the **built-in**
  agent-visible catalog (`getToolDefsForSource("agent")` ∩ built-in registry).
  Generated/dynamic capabilities are deny-by-default for Brain v0.1
- malformed tool names, oversized argument objects
- unresolved dependencies, self-dependencies, and cycles (topological check)
- step counts over the bound

Legacy `sidekick_`-prefixed tool names in a plan resolve to their canonical
catalog entry, exactly as the Agent Bridge loop does.

A rejected plan gets bounded correction: the validator's error strings are fed
back to the planner for up to `MAX_PLANNING_ATTEMPTS` total attempts. Error
strings may embed short model-chosen fragments (a bad tool or type name), but
these are sanitized and length-capped at the source (`frag()`), and the
corrected plan is fully revalidated — the validator, never the model, decides
acceptance on every attempt; past the bound the task fails closed.

## Tool execution and the dispatcher boundary

Every `tool` step runs through `callAgentTool(name, args, {taskId, executionId,
rootExecutionId})` — the sole sanctioned dispatcher seam. Brain never requires
`tools/context` internals, never constructs an execution context, never reuses
a context across steps, and never passes approval/bypass flags. Per-step schema
validation, policy, approval, redaction, and audit re-run in the dispatcher for
every call. The validator's allowlist is advisory defense-in-depth; the
dispatcher remains authoritative.

## Compute use

Brain requests logical capabilities only; Compute Placement decides the
provider/model/worker/executor/accelerator. Memory embeddings use the
`embeddings` capability (NPU-preferred, policy-gated CPU fallback); planning and
synthesis use `chat`/`generate`. Brain hardcodes no worker, provider, model,
endpoint, or device — those belong to Compute Placement configuration.

## Memory

Retrieval uses `memory.js`'s scoped, bounded, redacted wrappers
(`recallMemoryForTextAsync`), never `dbStore` directly. Recalled memory is
treated as **untrusted** and is redacted and layered into prompts as
clearly-labeled user-role content, never system authority. Memory write-back
for a completed task goes through the existing redaction-guarded
`recordAgentTaskMemory`. Brain stores no secrets, raw tool output, unredacted
transcripts, chain-of-thought, or speculative conclusions, and does not create
or promote generated tools.

## Evidence and honesty

For a request classified as needing current evidence, the verifier requires at
least one **successful** evidence tool call before a factual answer is allowed
(the `respond` echo tool does not count, and failed/approval-pending calls do
not count). With no evidence, Brain fails closed with an honest "Sidekick could
not inspect the requested state" message rather than synthesizing a plausible
answer. A tool step failure is honest failure, never fabricated evidence. Model
chain-of-thought is never persisted or displayed.

## Task lifecycle and cancellation

States: `queued → planning → validating → running → [waiting_for_approval] →
verifying → completed | failed | cancelled | timed_out`.

Terminal states are **monotonic and sticky**: once a task is cancelled or timed
out, a late-arriving tool or compute result can never flip it to completed
(every terminal transition is guarded by a check-and-set). Because Compute calls
have a timeout ceiling but no proactive cancellation, Brain enforces its own
total-task and per-step deadlines and simply discards late results. Ambiguous
side-effecting steps are not auto-replayed after a restart.

## Approval

A tool step whose dispatcher result is `approval_required` parks the task in
`waiting_for_approval` (surfacing the `approvalId`); Brain never retries or
bypasses an approval-gated step and never asks the model to avoid approval.

## Observability

The transcript carries an additive `brain` field
(`{ enabled, state, evidence_count, awaiting_approval, error }` — `error` is
the sanitized terminal failure reason, `null` on success, so a failed Brain
task is diagnosable post-hoc without having watched the live stream) and Brain emits
platform events (`brain.enabled`, `brain.state`, `brain.plan_validated`,
`brain.step_started`/`brain.step_completed`, `brain.waiting_for_approval`,
`brain.evidence_missing`). Plan internals and chain-of-thought are not exposed —
only the validated high-level step list, execution status, evidence references,
and sanitized failures.

## Prompt-injection resistance

The user goal, retrieved memory, tool output, and provider output are all
treated as untrusted data: separated from Sidekick's system instructions,
labeled untrusted, and redacted before entering a prompt. Because steps come
only from the validated plan object — never from free text produced during
execution — untrusted content that appears to "add a step" is inert.

## Limitations

- Compute calls cannot be aborted mid-flight; a timed-out Brain task may still
  hold a live socket until the compute ceiling (300s chat/generate, 30s embed).
  Brain bounds this only by its conservative concurrency and by discarding late
  results.
- The evidence classifier is heuristic; the verifier is the real guarantee for
  live-state honesty.
- Redaction is regex-based; novel secret formats can slip through (shared with
  the rest of Sidekick).

## Manual verification

With `SIDEKICK_BRAIN_ENABLED=1` in the Agent tab:

- **Live state:** "Check disk usage and tell me whether anything needs
  attention." → a registered tool runs, the answer is evidence-based, and the
  transcript `brain.state` is `completed`.
- **Conceptual:** "Explain what an NPU is." → no unnecessary tool, bounded
  generation, clear answer.
- **Approval:** a high-risk action (with approval mode on) parks in
  `waiting_for_approval` with an `approvalId` and is never auto-executed.

With the flag unset, the Agent tab behaves exactly as before.
