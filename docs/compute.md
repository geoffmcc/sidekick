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
