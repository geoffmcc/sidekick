# ADR: Brain v0.1 orchestration boundary

## Status

**Accepted — 2026-07-18.**

Introduces a small, bounded, feature-flagged orchestration layer
(`src/brain/`) over the existing Agent Bridge, Compute Placement, tool
dispatcher, and memory/approval systems. Adds no new execution authority: Brain
plans and coordinates, but every effect flows through an existing seam.

## Context

The Agent Bridge (Stage 1) reliably executes single tool loops, and Compute
Placement (Stage 2) routes logical model workloads. What was missing was a
bounded coordinator that could, for one request, decide what evidence is
needed, retrieve scoped memory, plan a short sequence of steps, execute them
safely, verify the evidence, and synthesize an answer — without becoming an
unbounded autonomous agent or a second execution path around the dispatcher.

A focused Brain-readiness review confirmed the required seams were clean and,
critically, that a new module cannot forge a trusted execution context (the
`SOURCE_CAPABILITY` symbol is module-private), so Brain must go through
`callAgentTool`. A trust-boundary security review then drove the specific
requirements below.

## Decision

1. **Deterministic plan validation is the trust boundary.** An LLM produces a
   strict JSON plan; a separate pure function (`plan-validator.js`) validates it
   with no model call and rejects the whole plan atomically on any failure. The
   model's asserted risk, approval, trust, provenance, and "verified" fields are
   never honored — those are computed server-side. Prototype-pollution shapes,
   unknown fields, unknown/invisible/generated tools, cycles, and bound
   violations are rejected before any step runs.
2. **Execution only through the dispatcher.** Every tool step uses
   `callAgentTool`; Brain never touches dispatcher/context internals, never
   reuses a context, never passes bypass flags. Per-step policy, approval,
   redaction, and audit re-run centrally.
3. **Bounded by frozen, non-overridable limits.** Step count, planning
   attempts, retries, total/per-step time, tokens, retrieved memories, and
   evidence size live in a frozen `BRAIN_LIMITS` (mirroring
   `CONTINUATION_LIMITS`) so a plan cannot exceed them regardless of
   environment.
4. **Fail closed and honest.** Plan-validation failure, missing evidence for a
   live-state answer, tool/compute failure, classification denial, and
   approval-required all fail or park rather than degrading to a plausible
   answer. Chain-of-thought is never persisted or displayed.
5. **Monotonic lifecycle.** Terminal states are sticky and every
   `→ completed` transition is guarded by a check-and-set, so a late compute or
   tool result cannot resurrect a cancelled/timed-out task. Because compute
   calls cannot be aborted mid-flight, Brain enforces its own deadlines and
   discards late results.
6. **Feature-flagged, off by default.** `SIDEKICK_BRAIN_ENABLED` gates a single
   early branch in `runAgent`; the disabled path is byte-for-byte the prior
   behavior, and the Brain module is loaded with a guarded require so a load
   error cannot affect it. Rollback is unsetting the flag.
7. **Untrusted-data discipline.** User goal, memory, tool output, and provider
   output are separated from system instructions, labeled untrusted, and
   redacted before entering prompts. Steps come only from the validated plan
   object, so injected "add a step" text is inert.
8. **Compute via logical capabilities only.** Brain requests
   embeddings/chat/generate; Compute Placement decides
   provider/model/worker/executor/accelerator. No hardware or model identifiers
   are hardcoded in Brain.

A prerequisite correctness fix rode along because Brain's generation path
depends on it: `OllamaProvider.chat`/`.generate` built their `options` with
`{...}.filter(...)` on an object literal, which threw `TypeError` on every real
Ollama chat/generate call. Replaced with an explicit undefined-pruning helper.

## Consequences

- Brain reuses, rather than duplicates, the Agent Bridge classifier, the
  dispatcher, Compute Placement, and the memory/approval systems.
- The additive transcript `brain` field and `brain.*` platform events give
  observability without exposing plan internals or chain-of-thought.
- The Ollama chat/generate path now works for the Agent Bridge as well (it
  shared the same bug), improving local-model reliability beyond Brain.
- Brain is disabled by default; enabling is an explicit, reversible operator
  choice.

## Limitations and residual risk

- Compute calls have a timeout ceiling but no proactive cancellation; a
  timed-out Brain task may hold a live socket until the ceiling. Bounded by
  Brain's conservative concurrency and by discarding late results.
- The evidence classifier is heuristic; the verifier is the real guarantee for
  live-state honesty — a verifier regression re-opens fabrication risk.
- Redaction is regex-based (shared Sidekick limitation).
- Generated/dynamic tools remain dispatch-reachable by name; the validator's
  built-in-only allowlist is what keeps Brain v0.1 from planning them, so that
  allowlist must stay pinned to built-ins.

Complements [ADR: Compute Placement v1](adr-compute-placement.md) and the Agent
Bridge tool-use and follow-up work.
