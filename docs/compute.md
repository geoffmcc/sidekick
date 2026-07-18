# Sidekick Compute

Sidekick Compute runs allowlisted model-oriented jobs through enrolled workers. It is not a remote shell, arbitrary command runner, or general GPU batch service.

## Supported Workloads

Compute jobs are limited to the versioned job contract in `src/compute/job-contract.js`:

- `chat`
- `generate`
- `embeddings`

Supported distributed executors are allowlisted:

- `mock.inference`
- `ollama.inference`

Job payloads reject command-like keys such as `command`, `argv`, `executable`, and `shell`. Unsupported job types such as `custom` and `transcription` are rejected by the HTTP API and job manager.

## Trust Boundaries

Compute HTTP routes are split into three groups:

- `/compute/enrollment/*`: enrollment exchange uses one-time enrollment tokens.
- `/compute/worker/*`: worker protocol routes require scoped worker credentials.
- `/compute/admin/*`: administrative routes require the Sidekick API key.

Initial compatibility aliases under `/compute/*` remain available, but they are explicitly authenticated. Unknown compute routes fail closed.

Worker credentials are issued only during enrollment or rotation. The server stores credential hashes. Worker detail APIs expose `hasCredential`, not the credential value.

## Enrollment And Workers

An administrator creates an enrollment token with `/compute/enrollment/tokens`. A worker exchanges that token at `/compute/enrollment/exchange` and receives a persistent worker credential.

The worker agent in `src/compute/worker-agent.js` can be configured with:

- `SIDEKICK_URL` or `SIDEKICK_SERVER_URL`
- `SIDEKICK_ENROLL_TOKEN` for first enrollment
- `SIDEKICK_WORKER_CONFIG` for persisted worker credentials
- `SIDEKICK_WORKER_POLL_MS`
- `SIDEKICK_HEARTBEAT_MS`
- `SIDEKICK_WORKER_LEASE_MS`
- `SIDEKICK_WORKER_CONCURRENCY`
- `SIDEKICK_WORKER_SHUTDOWN_GRACE_MS`

The worker entry point in this repository is:

```bash
node src/compute/worker-agent.js enroll --server http://<sidekick-host>:4097 --token <enrollment-token>
```

`package.json` publishes a `sidekick-compute-worker` `bin`, and
`npm run package:worker` builds a standalone, dependency-free package under
`dist/` with a `SHA256SUMS` manifest. Per-platform service installers (systemd,
launchd, winsw) live under `packaging/compute-worker/` and register the worker as
a managed OS service:

```bash
sidekick-compute-worker enroll --server http://<sidekick-host>:4097 --token <enrollment-token> --service
```

The agent validates persisted credentials, writes them atomically, and tightens POSIX file permissions where the filesystem supports it (and applies NTFS ACLs on Windows). On Windows-mounted WSL paths, the mount may report broader mode bits even when Node writes with `0600`.

The worker also supports a multi-dimensional lifecycle state model, a
subcommand CLI (`run`/`enroll`/`status`/`doctor`/`rotate-credential`/`version`),
persistent configuration, credential rotation and re-enrollment, resilient
reconnection, and scheduling that stops parked workers from claiming new jobs.
See **[`compute-worker.md`](compute-worker.md)** for the full worker lifecycle.

## Hardware, Backends, And Models

Worker reporting is shell-free. It uses Node APIs and explicit environment configuration rather than probing through shell commands.

Supported reporting inputs:

- `SIDEKICK_WORKER_ACCELERATORS_JSON`: explicit accelerator metadata.
- `CUDA_VISIBLE_DEVICES` or `NVIDIA_VISIBLE_DEVICES`: CUDA visibility hints.
- `ROCR_VISIBLE_DEVICES` or `HSA_OVERRIDE_GFX_VERSION`: ROCm visibility hints.
- Apple Silicon detection from Node platform/architecture.
- CPU fallback when no accelerator is reported.
- `SIDEKICK_WORKER_BACKENDS_JSON`: explicit backend metadata.
- `OLLAMA_URL`: optional Ollama backend, with credentials stripped before reporting.
- `SIDEKICK_WORKER_MODELS_JSON`: explicit model inventory.
- `OLLAMA_MODEL`: optional Ollama model inventory entry.

Worker heartbeat and admin inspect APIs expose platform, architecture, worker version, protocol version, providers, executors, model inventory, limits, health, and utilization metadata.

## Placement (v1)

`src/compute/placement.js` is the shared placement decision core. Both routing
paths delegate candidate evaluation to it so their decisions cannot drift:

- **Direct inference** (`inference-service` `chat`/`generate`/`embed`, used by
  the Agent Bridge, memory embeddings, and the `llm`/`embed` tools) ranks
  provider+model candidates with the shared predicates and executes the best
  candidate through provider adapters, falling back only across candidates
  that passed the same gates.
- **Distributed jobs** (`job-manager` claim path) evaluate each polling worker
  with the same predicate (`evaluateWorkerCandidate`) before leasing.

### Placement requests

A logical placement request is strict and versioned (`version: 1`). Callers
state *what* they need — capability (`embeddings`, `chat`, `generate`),
`data_classification` (mandatory; a missing classification is rejected, never
treated as unrestricted), optional `trust_level_required`, logical
`requirements` (`tools`, `vision`, `structured_output`, `dimensions`,
`context_limit`, `sequence_length`), and `preferences.allow_fallback`.
Callers can never select endpoints, credentials, devices, workers, executors,
trust labels, or provenance; those fields are rejected wherever they appear,
including inside compute-job payloads (checked at `createJob`).

### Decision policy

- **Embeddings** prefer a certified OpenVINO model on an enrolled, healthy,
  trust- and classification-eligible worker — NPU-certified first (reason
  `preferred_certified_npu_embedding`), with CPU fallback offered only when
  the manifest permits it (`same_model_cpu`) and the request allows fallback.
  Certification comes from the OpenVINO model manifest, never from a worker's
  self-reported tier: a worker claim can downgrade a tier but never upgrade
  one, and unlisted models are never certified.
- **Chat/generation** prefer registered provider models (Ollama first by
  scoring) matching the required context window, tool, and structured-output
  capabilities.
- **Policy denials never become fallbacks**: classification, trust,
  certification, validation, and unknown-capability failures fail closed;
  only transient execution failures trigger fallback, and only across
  candidates that already passed every gate.
- Routing rules (`compute_routing_rules`) are operator preferences applied
  strictly after the gates; a rule can narrow or order candidates but cannot
  re-admit a rejected one. Rule arrays are validated on write.

### Concurrency

Claim decisions re-read worker concurrency inside the claim transaction (the
authenticated snapshot is never trusted for the guard) and enforce
per-executor limits: `openvino.text_embedding` holds a single resident NPU
model, so at most one active lease per worker uses it even when the
worker-wide limit has headroom (`concurrency_exhausted`).

### Provenance

A requested accelerator is never recorded as the actual accelerator. On
completion, the worker's claimed device is cross-checked against the manifest
for the job's model and persisted on the attempt as `accelerator`,
`requested_accelerator`, and `accelerator_verification`:

- `manifest_confirmed` — claimed device is the model's certified device
- `manifest_confirmed_fallback` — permitted fallback device with an explicit
  fallback report
- `unverified` — model not manifest-listed; the claim is recorded as a claim
- `rejected_claim` — device outside the manifest-permitted set; no accelerator
  is recorded

Fallbacks and failed attempts append to the job's `fallback_history_json`.
Provider-path execution always reports `acceleratorVerification:
"not_verified"` — GPU-backed providers are an expectation, never a verified
fact, and Sidekick reports exactly that.

### Explain mode

`sidekick_compute_route action="explain"` (and `compute.explainPlacement`)
runs the same decision code as real placement with zero execution and zero
state mutation, returning the selected candidate, permitted fallbacks, and
sanitized rejection reasons (`worker_offline`, `worker_stale`,
`capability_missing`, `executor_missing`, `model_missing`,
`model_not_certified`, `static_shape_required`, `data_classification_denied`,
`trust_too_low`, `circuit_open`, `concurrency_exhausted`,
`fallback_disabled`, …). Explain output never contains endpoints, secrets, or
raw worker config blobs.

### Limitations

- Worker hardware reports are attested by the enrolled worker, not
  independently measured by the server; OpenVINO capabilities pass a real
  local device probe before being advertised, which is the strongest signal
  available. NPU/CPU provenance is therefore "attested by a trusted-enrolled
  worker and manifest-consistent", not hardware-attested.
- Direct (synchronous) embedding execution still runs on provider adapters;
  the certified-NPU path executes through compute jobs. The placement
  decision reports the preferred path either way.

## Jobs And Leasing

Admins create jobs with `/compute/admin/jobs`. Workers claim jobs with `/compute/worker/jobs/claim`.

Leases are unguessable, bounded, renewable, and checked on every worker mutation. Stale lease completion, cross-worker progress, cross-worker artifact finalization, and delayed success after cancellation are rejected.

Retries use `retry_wait` plus configured or exponential backoff. Recovery requeues expired eligible leases or dead-letters exhausted jobs.

## Results And Artifacts

Workers upload artifacts with:

```text
POST /compute/worker/jobs/:jobId/artifacts/upload
```

Workers finalize artifacts with:

```text
POST /compute/worker/jobs/:jobId/artifacts/:artifactId/finalize
```

Artifact metadata records job, attempt, worker, lease, type, name, content type, hash, size, state, created time, and finalization time. Upload validates lease ownership, size limits, and content hashes. Finalization is idempotent and rejects hash/size mismatches, cross-worker attempts, stale leases, and cancelled jobs.

The worker agent uploads and finalizes `result.txt` before completing a job. Inline completion artifacts remain supported for compatibility and are normalized into the same artifact metadata shape.

## Cancellation And Recovery

Admins cancel jobs with:

```text
POST /compute/admin/jobs/:jobId/cancel
```

Workers check cancellation with:

```text
POST /compute/worker/jobs/:jobId/cancellation
```

Workers acknowledge cancellation with:

```text
POST /compute/worker/jobs/:jobId/cancellation/ack
```

The worker agent checks cancellation during cancellable waits. When cancellation is observed, it acknowledges the cancellation and avoids publishing result artifacts or completing the job.

## Dashboard And APIs

The MCP server exposes compute admin APIs under `/compute/admin/*`.

The dashboard has a first-class Compute page for fleet status, enrollment, worker controls, recent jobs, job details, cancellation, retry, and expired lease recovery.

The dashboard backend exposes authenticated read APIs under:

- `/api/compute`
- `/api/compute/workers`
- `/api/compute/jobs`
- `/api/compute/jobs/:jobId`

It exposes authenticated dashboard mutations under:

- `POST /api/compute/enrollment-tokens`
- `POST /api/compute/workers/:workerId/disable`
- `POST /api/compute/workers/:workerId/enable`
- `POST /api/compute/workers/:workerId/revoke`
- `POST /api/compute/jobs/:jobId/cancel`
- `POST /api/compute/jobs/:jobId/retry`
- `POST /api/compute/recover`

Job detail includes attempts and artifacts. Job stats include status counts, type counts, active lease count, attempt count, and artifact counts by state.

## Testing

Normal deterministic tests do not require a GPU or live backend:

```bash
node test/compute.test.js
node test/compute-protocol.test.js
node test/dashboard-api.test.js
npm test
```

The live worker smoke test is disabled by default. To opt in, set:

```bash
SIDEKICK_COMPUTE_LIVE=1
SIDEKICK_COMPUTE_LIVE_URL=http://127.0.0.1:4097
SIDEKICK_COMPUTE_LIVE_API_KEY=<admin api key>
```

Then run:

```bash
node test/compute-live-worker.test.js
```

The live test submits a harmless chat job, waits for distributed completion, verifies worker identity/result/artifact metadata, and cancels the job on timeout.

## Non-Goals

Sidekick Compute does not provide arbitrary shell execution, raw process spawning, custom executable selection, unrestricted file transfer, or generalized GPU job scheduling. Add new workload types only by extending the allowlisted job contract, executor scope, protocol tests, dashboard/API docs, and security review together.
