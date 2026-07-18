# ADR: Compute Placement v1

## Status

**Accepted — 2026-07-18.**

Introduces a single authoritative placement decision core shared by both
compute routing paths. Builds on the existing Compute infrastructure
(provider/model/worker registries, job/lease system, OpenVINO manifest); adds
no second registry, queue, or routing database.

## Context

Before this change, Sidekick Compute had two independent, non-overlapping
routing paths:

- **Direct inference** — `inference-service` used `capability-router`
  `selectProvider`/`selectWithFallback` over the provider and model registries.
  It scored provider health and filtered by data classification, but had no
  worker, executor, or accelerator awareness. Its fallback candidate loop
  skipped the capability/requirement filters, and `embed` had no fallback at
  all.
- **Distributed jobs** — `job-manager` `workerCompatibility`/`claimNextJob`
  matched a queued job against a polling worker using the worker's
  self-reported executors, models, and certification tier. It shared no logic
  with the router and enforced neither data classification nor trust.

The two paths reimplemented overlapping concerns with different data models and
different gaps. Three security-relevant weaknesses existed: data classification
and trust were unenforced on the job path; the enrollment token's
data-classification scope was discarded rather than persisted; per-executor
concurrency was unenforced, so the single-resident-NPU-model worker could be
double-claimed. Provenance columns (`compute_job_attempts.accelerator`,
`compute_jobs.fallback_history_json`) existed in the schema but had no writers.

## Decision

Add `src/compute/placement.js` as the shared decision core. Both paths delegate
candidate evaluation to its pure predicates (`evaluateProviderCandidate`,
`evaluateWorkerCandidate`), and the same code backs a dry-run
`explainPlacement`, so real placement and explain cannot diverge.

Key decisions:

1. **Strict, versioned, fail-closed request schema.** `data_classification` is
   mandatory (a missing classification is never "unrestricted"). Unknown fields
   are rejected. Callers state logical requirements only; endpoints,
   credentials, devices, workers, executors, trust labels, and provenance are
   rejected wherever they appear, including inside compute-job payloads.
2. **Manifest is the certification authority.** Worker-reported certification
   tiers can only downgrade the OpenVINO manifest tier, never upgrade it;
   unlisted models are never certified. This closes the "unknown tier ⇒
   certified" default that previously trusted worker self-reports.
3. **Persist and enforce the worker data-classification scope.** The enrollment
   token's `allowedDataClassifications` is stored on the worker row (new column,
   migration `024` + `ensureColumn`) and enforced by the shared predicate;
   existing workers default to the historical implicit scope.
4. **Server-side provenance on completion.** The worker's claimed device is
   cross-checked against the manifest and recorded as `accelerator`,
   `requested_accelerator`, and `accelerator_verification`
   (`manifest_confirmed` / `manifest_confirmed_fallback` / `unverified` /
   `rejected_claim`) inside the same lease-guarded transaction as the result,
   so a superseded attempt can neither record nor overwrite it. A requested
   accelerator is never recorded as actual.
5. **Per-executor concurrency inside the claim transaction.** Worker
   concurrency is re-read within `claimNextJob`'s `BEGIN IMMEDIATE` (the
   authenticated snapshot is not trusted for the guard), and executors with a
   declared `maxConcurrent` (OpenVINO's single resident NPU model) are limited
   per worker.
6. **Rules are preferences only.** Routing rules are applied after the security
   gates and can never re-admit a rejected candidate. Rule arrays are validated
   on write.
7. **Honest provider provenance.** Provider (Ollama/OpenAI-compatible)
   execution reports `acceleratorVerification: "not_verified"` — GPU use is an
   expectation, not a verified fact.

## Consequences

- The direct-inference fallback gap and missing embed fallback are fixed as a
  byproduct of sharing the core; fallback candidates now pass the same filters
  as primaries.
- All in-process LLM/embedding callers (Agent Bridge `callLLM`, memory
  embeddings, `llm`/`embed` tools) now pass an explicit `data_classification`
  (`private`), closing the prior fail-open where a missing classification
  skipped filtering.
- `compute_route action="explain"` gains a unified placement block covering
  worker candidates; the legacy provider-only fields are preserved unchanged.
- Placement decisions are advisory to execution: the dispatcher, lease
  ownership, approval, and worker authentication boundaries are unchanged and
  remain authoritative.

## Limitations and residual risk

- Worker hardware is attested by the enrolled worker, not independently
  measured by the server. OpenVINO capabilities pass a real local device probe
  before advertisement, and completion provenance is manifest-consistent, but
  "NPU" ultimately means "attested by a trusted-enrolled worker and consistent
  with the manifest," not hardware-attested. This is stated in provenance
  output rather than hidden.
- The compute API bind and authentication posture are unchanged; any future
  placement/explain endpoint must inherit the existing `requireAdmin` /
  `requireWorker` gates.

Supersedes nothing; complements [ADR: Secure OpenVINO NPU Worker
Integration](adr-openvino-integration.md).
