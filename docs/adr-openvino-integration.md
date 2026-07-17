# ADR: Secure OpenVINO NPU Worker Integration

## Status

**Proposed — revision 2** — not yet accepted. Architecture decision depends on Stage 1 and Stage 2 compatibility spike results (§Spike) for at least one production-candidate embedding model: Qwen3-Embedding-0.6B (quality-oriented primary) and intfloat/e5-small-v2 (compact baseline). A Stage 0 synthetic smoke test may optionally verify basic openvino-node plumbing before real-model work begins.

Revision 1 had blocking issues on discovery, limits, state machine, model manifest, path safety, helper implementation, and attack-surface accuracy.

## Context

Sidekick Compute currently supports `ollama.inference` and `mock.inference` executors, routed through enrolled workers reporting CPU and GPU (Ollama) backends. The user has an Intel NPU (`Intel(R) AI Boost`) on a Windows 11 x86-64 host with an RTX 5070, and has validated OpenVINO 2026.2.1 running the CLAP text encoder on the NPU with acceptable performance (~8-9ms NPU vs ~20ms CPU, cosine similarity ~0.999996). The CLAP audio encoder was validated on CPU and explicitly rejected on NPU (~0.59 cosine similarity) — this rejection is permanent.

The goal is to expose the NPU as a trusted compute backend for validated text embedding workloads through the existing Sidekick Compute protocol, with production-grade discovery, certification, path safety, and lifecycle management.

## Superseded Decisions (Revision 1)

The following revision-1 decisions are superseded and must not be followed:

1. **Env-var NPU discovery** — revision 1 relied on `SIDEKICK_WORKER_ACCELERATORS_JSON` for NPU detection. Production discovery must query the OpenVINO runtime directly. (§Decision.5)
2. **Inaccurate Node.js bindings claim** — revision 1 stated OpenVINO lacks stable Node.js bindings. This is incorrect; `openvino-node` exists and must be evaluated. (§Alternatives.1)
3. **Undefined helper implementation** — revision 1 left the helper runtime unspecified. The helper must be explicitly chosen with documented rationale. (§Decision.1)
4. **Generic input limits** — revision 1 imposed 8,192 tokens / 256 texts / 64 KB as universal limits. Limits must come from the registered model profile. (§Decision.2)
5. **Flat NPU state machine** — revision 1 had 8 states conflating device and certification. Device and certification must be separate, with granular reason codes. (§Decision.5)
6. **Weak model manifest** — revision 1 stored minimal metadata in `compute_models`. Trusted model manifests must include hashes for all files, upstream revision, license, tensor profiles, and certification thresholds. (§Decision.3)
7. **Relative IR path trust** — revision 1 trusted relative paths without canonicalization. Paths must be canonicalized and proven to remain within the trusted store. (§Decision.4)
8. **Default relative model store** — revision 1 defaulted to `./openvino-models/`. Must use an absolute protected Windows location. (§Decision.4)
9. **PATH inheritance** — revision 1 filtered parent PATH. Must use fixed absolute executable path with no search path. (§Decision.1)
10. **Dual model store env vars** — revision 1 used both `SIDEKICK_OPENVINO_MODELS_DIR` and `OPENVINO_MODELS_DIR`. Must use a single authoritative setting. (§Decision.4)
11. **Caller-controlled dimensions** — revision 1 allowed arbitrary dimension requests. Embedding dimension is fixed by the model. (§Decision.2)
12. **Implicit model provisioning** — revision 1 did not separate provisioning from runtime. Model provisioning must be an explicit administrative operation. (§Decision.3)
13. **Implicit fallback** — revision 1 used vague fallback language. Fallback policy must be explicit in the job contract with a bounded enum. (§Decision.8)
14. **Inaccurate attack-surface claim** — revision 1 stated "no new attack surface." Must accurately describe local risks. (§Consequences.2)
15. **Inaccurate platform claim** — revision 1 stated "Windows-only." Must say "this initial implementation targets native Windows." (§Consequences.4)
16. **Unpinned runtime** — revision 1 did not pin the OpenVINO version. Must pin and document the tested version. (§Decision.1)
17. **Unspecified helper lifecycle** — revision 1 did not specify per-request vs persistent. Must be explicitly designed. (§Decision.1)
18. **Overloaded compute_models** — revision 1 reused `compute_models` for trusted manifest data. May need a separate registry. (§Decision.3)
19. **CLAP audio denial not explicit** — revision 1 mentioned it in passing. Must be enforced before helper execution. (§Decision.7)

## Decision

### Candidate A: In-process `openvino-node`

**Status:** Proposed — not selected. Pending compatibility spike (§Spike).

The Sidekick worker agent would load `openvino-node` directly as an in-process module. This section describes the candidate architecture; no production runtime has been selected yet.

**Rationale:**

- `openvino-node` is the official OpenVINO JavaScript binding (`openvino/openvino-node`). It provides `Core`, `CompiledModel`, `InferRequest`, and tensor APIs that cover the text-embedding use case.
- In-process loading would eliminate a separate helper executable, its packaging, its IPC protocol, and its dependency management.
- If cancellation is not proven by the spike, a separate helper or worker-process restart is needed for hard containment.

**Packaging:**
- `openvino-node` is a native addon distributed as a prebuilt binary for supported platforms (Windows x86-64).
- It would be listed in `package.json` dependencies and installed with `npm install`.
- The native binary is platform-specific; the Sidekick package would document which platforms are supported.
- OpenVINO runtime libraries are bundled by `openvino-node` or would need explicit inclusion in the deployment.

**Dependency implications:**
- Adds a native addon dependency (~200-400MB including runtime libraries).
- Requires the Intel NPU driver and runtime to be installed on the host.

**Licensing:**
- `openvino-node` is Apache 2.0. Sidekick is GPLv3. Apache 2.0 is compatible with GPLv3. No licensing conflict.

**Crash isolation and cancellation:**
- OpenVINO inference runs in the worker process via the selected in-process architecture. An OpenVINO crash takes down the worker, which is already supervised and restartable.
- `InferRequest` has `infer()` (synchronous, returns immediately) and `inferAsync()` (returns `Promise`). Neither has a `cancel()` method. Bounded JavaScript `Promise.race` timeouts and lease expiry prevent an expired or cancelled job result from being committed, but they do **not** terminate the stuck native `infer()` call or restore worker capacity.
- Hard cancellation of in-process native execution has **not** been demonstrated at the API level and must be tested in the compatibility spike using a sacrificial child process with parent-enforced termination.
- If the spike does not prove reliable hard cancellation, the production architecture must either: (a) use an isolated helper process that can be terminated, or (b) accept that a hung in-process inference requires terminating and restarting the entire worker (which discards all concurrent jobs).

**Security:**
- Model loading would be restricted to the trusted model store (see §4).
- No new network listener would be introduced.

### 1.6. Runtime Version Pinning

**Tested version (Python):** The Python OpenVINO 2026.2.1 runtime was validated for CLAP text encoder on Intel NPU with cosine similarity ~0.999996. The `openvino-node` binding has **not** been validated for NPU enumeration, model loading, inference, or output parity — that is the purpose of the compatibility spike (§Spike).

**Release status:** OpenVINO 2026.2.1 is identified by official distribution documentation as a development/non-LTS release. This is noted as a risk.

**Pin strategy:**
- Pin `openvino-node` to the exact npm package version (e.g., `2026.2.1`).
- **Do not assume** that an npm package version maps to or bundles the Python-tested OpenVINO runtime version. The spike must programmatically verify the runtime version via `core.getVersions(deviceName)` and include it in the spike report.
- Document the tested version, tested model, tested device, and tested precision in the model certification record (<code>trusted_model_certifications</code>).
- Define certification invalidation criteria: any change to `openvino-node` version, NPU driver version, or host OS version invalidates the existing certification and requires re-validation.
- Rollback: if a newer OpenVINO version breaks NPU support, pin to the last working version and document the regression.

### 2. Model-Specific Limits

Input limits are not globally defined. Each registered model profile specifies its own validated static shape profiles. The job contract enforces the limits declared by the requested model's profile.

Jobs that exceed the model's declared limits (sequence length, batch size) are rejected at the job contract validation layer before reaching the inference path.

### 3. Trusted Model Manifest and Certification Registry

Model identity and device-specific certification are **separate** structures.

#### `trusted_models` (immutable model metadata)

Stores model identity, provenance, and profile invariant across all devices and workers:

| Field | Description |
|-------|-------------|
| `model_id` | Registered model identifier (e.g., `clap-text-v1`) |
| `display_name` | Human-readable name |
| `framework` | `openvino` |
| `upstream_repository` | Source repository URL |
| `upstream_revision` | Pinned commit/tag |
| `license` | Model license identifier (e.g., `apache-2.0`) |
| `embedding_space_id` | Identifier for the embedding space (e.g., `clap-v1-512d`) |
| `output_dimensions` | Fixed output vector dimension (e.g., 512) |
| `supported_devices` | JSON array: `["NPU", "CPU"]` |
| `fallback_policy` | One of: `npu_required`, `npu_preferred`, `cpu_allowed`, `no_fallback` |
| `input_profiles` | JSON: array of static shape profiles with tensor names, types, and shapes |
| `file_manifest` | JSON: array of `{path, sha256, size_bytes}` for every file in the model |
| `status` | `active`, `deprecated` |

All data in this table is immutable after registration. A model update requires a new `model_id`.

#### `trusted_model_certifications` (device-specific certification)

Keyed by the full certification context:

| Field | Description |
|-------|-------------|
| `certification_id` | Auto-generated primary key |
| `model_id` | Foreign key to `trusted_models.model_id` |
| `manifest_hash` | SHA-256 of the entire `trusted_models.file_manifest` JSON at time of certification |
| `preprocessing_hash` | SHA-256 of the tokenizer/preprocessing configuration (includes `tokenizer_config` and `preprocessing_version`) |
| `device_identity` | Device identifier string (e.g., `Intel.NPU`, `Intel(R) AI Boost`) |
| `device_type` | `NPU`, `CPU` |
| `runtime_package_version` | OpenVINO npm package version (e.g., `2026.2.1`) |
| `runtime_core_version` | Runtime build number from `core.getVersions(deviceName)` |
| `npu_driver_version` | NPU driver version from `core.getProperty(device, "FULL_DEVICE_NAME")` and related properties |
| `npu_compiler_version` | NPU compiler version from `core.getProperty(device, "COMPILER_VERSION")` when available |
| `windows_build` | Windows build number (e.g., `10.0.22631`) |
| `tested_input_profile` | JSON: the exact static shape profile tested (e.g., `{"batch": 1, "sequence": 77}`) |
| `precision` | Tested precision (e.g., `FP16`) |
| `certification_result` | One of: `pending`, `validated`, `certified`, `ready`, `degraded`, `quarantined`, `deprecated` |
| `certification_reason` | Structured reason string if not `ready` (e.g., `accuracy_below_threshold`, `shape_mismatch`, `non_finite_output`) |
| `certification_evidence` | JSON: test vectors, cosine similarity scores, output norm range, NaN/Inf counts |
| `certified_at` | ISO timestamp of certification attempt |
| `certified_by` | Who/what performed the certification (e.g., `spike-apr-2026`, `worker-agent-v1`) |

A certification is specific to one model+manifest+preprocessing+device+runtime+driver+OS+batch+precision combination. Changing any of these fields from a previously certified record creates a new unvalidated state — the old certification is not automatically invalidated but is flagged as potentially stale.

#### Tokenizer and Attention-Mask Parity

The `openvino-node` compatibility spike must prove tokenizer parity with the validated Python reference:
1. The same input text produces the same `input_ids` (exact integer match).
2. The same input text produces the same `attention_mask` (exact integer match).
3. Attention mask is correctly forwarded to the inference call (not dropped or re-derived).
4. Batched inputs with variable-length padding produce correct masks.
5. A mismatched tokenizer or missing attention mask is a correctness failure — the model must not be certified.

The `tokenizer_config` field in the trusted model record stores the tokenizer parameters used during certification.

### 4. Model Store and Path Safety

**Single authoritative setting:** `SIDEKICK_OPENVINO_MODELS_DIR` is the only environment variable for the model store path. `OPENVINO_MODELS_DIR` is not used.

**Default location (Windows):** `%ProgramData%\Sidekick\openvino-models\` — an absolute path under a protected Windows directory with restrictive ACLs.

**Permissions:**
- **Trusted model store** (`openvino-models\`): written by installer/provisioner only. The worker requires read and execute access only. Worker startup must not require write permission for this directory.
- **Runtime cache directory** (e.g., `%ProgramData%\Sidekick\openvino-cache\`): writable by the worker. Contains compiled model caches, temporary artifacts.
- **Certification and health-state directory** (e.g., `%ProgramData%\Sidekick\openvino-state\`): writable through the appropriate Sidekick service path.

Worker startup requires the trusted model store to be readable. If it is unreadable or missing, the worker logs a clear error and continues without NPU capability.

**Path canonicalization and traversal rejection:**

Every model file path is resolved against the trusted model store using `path.resolve()` and `fs.realpath()`. The resolved path is checked to ensure it starts with the canonical model store prefix. The following escapes are explicitly rejected:

- Directory traversal (`../`)
- Symlinks pointing outside the store
- Junctions (Windows NTFS junction points)
- Reparse points
- UNC paths (`\\server\share`)
- URLs (`file:///...`, `http://...`)
- Alternate data streams (`file.txt:stream:$DATA`)
- Case normalization escapes (Windows case-insensitive comparison)
- Null bytes in paths

If any escape is detected, the model load is rejected with an error and the model is quarantined.

### 5. Device State and Certification State Machine (Binding Scope)

**This ADR's specification is binding for the device state machine only.** The certification state machine is illustrative — its detailed lifecycle, transition rules, and storage structure will be defined in a separate document or future ADR revision under the trusted-model framework.

Device detection and model certification are **separate** state machines. A detected NPU is not automatically ready.

#### Device State Machine

```text
                         ┌─────────────────────────────┐
                         │          unknown             │
                         └─────────────┬───────────────┘
                                       │ probe
                                       v
                         ┌─────────────────────────────┐
                         │          probing             │
                         └─────┬───────┬───────┬───────┘
                               │       │       │
                 runtime       │  no   │  bad  │  detected
                 missing       │  NPU  │ props │
                               v       v       v
                    ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
                    │ unavailable  │ │ unavailable  │ │ detected_unvalidated │
                    │              │ │              │ │                      │
                    │ reason:      │ │ reason:      │ └──────────┬───────────┘
                    │ runtime_     │ │ device_not_  │            │ self-test
                    │ missing      │ │ enumerated   │            v
                    └──────────────┘ └──────────────┘  ┌──────────────────────┐
                                                        │ detected_validated   │
                                                        └──────────┬───────────┘
                                                                   │ repeated failures
                                                                   v
                                                        ┌──────────────────────┐
                                                        │ quarantined          │
                                                        │ reason: self_test_  │
                                                        │ failed / repeated_  │
                                                        │ failures            │
                                                        └──────────────────────┘

Direct transition to quarantined may also occur from detected_unvalidated
if self-test fails on first attempt.
```

**Device states:**
- `unknown` — Initial state before any probe attempt
- `probing` — Actively probing the OpenVINO runtime for NPU devices
- `unavailable` — NPU device is not available for use. Structured `reason` field distinguishes:
  - `runtime_missing` — OpenVINO runtime is not installed or not loadable
  - `device_not_enumerated` — Runtime loaded but `getAvailableDevices()` does not list NPU
  - `property_query_failed` — NPU listed but `getProperty()` fails (driver may be missing or incompatible)
  - `driver_incompatible` — NPU detected but driver version is incompatible with runtime
- `detected_unvalidated` — NPU device detected but not yet validated
- `detected_validated` — NPU device detected and passed runtime self-test
- `quarantined` — Device excluded due to repeated failures. Structured `reason`: `self_test_failed`, `repeated_failures`

#### Certification State Machine

```text
pending -> validated -> certified -> ready
                          |            |
                          v            v
                       quarantined  degraded
                          |
                          v
                       deprecated
```

**Certification states:**
- `pending` — Model registered but not yet validated on this device
- `validated` — Model loaded and compiled successfully on the device
- `certified` — Model passed self-test (bounded accuracy check, numerical stability)
- `ready` — Model is certified and available for production jobs
- `degraded` — Correctness still passes. Used only for non-correctness conditions: reduced performance, disabled batching, lost compile cache, temporarily restricted concurrency.
- `quarantined` — Model excluded due to correctness failure: accuracy below threshold, output shape mismatch, non-finite values, tokenizer/preprocessing mismatch, numerical instability, or any other correctness-relevant failure. A quarantined model is not routable.
- `deprecated` — Model no longer supported

**Capability advertisement requires:** device state = `detected_validated` AND certification state = `ready` for the specific model/device/runtime combination.

#### Self-Test and Certification

Before a model is certified on a device:

1. **Load and compile:** Load the model IR, compile for the target device.
2. **Shape validation:** Verify input/output tensor shapes match the registered profile.
3. **Numerical stability:** Run a bounded set of known-input / known-output test cases. Verify:
   - No NaN values in output
   - No Inf values in output
   - Output dimensions match registered profile
   - Cosine similarity with reference embeddings meets certification threshold
4. **Performance bounds:** Verify inference time is within the expected range for the device.
5. **Certification record:** Record device properties, driver version, runtime version, test results, and timestamp.

### 6. Model Provisioning (Separate Administrative Operation)

Model provisioning is an explicit, separate operation — not automatic on worker startup, helper startup, or first job.

**Provisioning workflow:**
1. Administrator downloads the model from a pinned source and revision.
2. Administrator verifies all file hashes against the model manifest.
3. Administrator places files in the trusted model store.
4. Administrator registers the model in the `trusted_models` table with file hashes and metadata.
5. Worker runs self-test and certification (§5) on next startup or explicit request.
6. Only after certification passes does the model become available for jobs.

**What provisioning is NOT:**
- No automatic download on worker startup.
- No download on first job request.
- No implicit model loading without prior certification.

### 7. CLAP Audio Denial (Mandatory)

The CLAP audio encoder was validated on CPU and explicitly rejected on NPU (cosine similarity ~0.59, far below the ~0.999 threshold). This rejection is permanent and enforced at multiple layers:

1. **Model registration:** The CLAP audio encoder model is not registered in the `trusted_models` table.
2. **Job contract:** Jobs requesting the CLAP audio model are rejected before reaching the helper.
3. **Certification:** The CLAP audio model must never contribute to generic NPU health certification.
4. **Self-test:** The NPU self-test uses only the CLAP text encoder. Audio model failures do not affect NPU device state.

### 8. Fallback Policy

Fallback policy is explicit in the job contract using a bounded enum:

```json
{
  "fallback_policy": "cpu_allowed"
}
```

**Allowed values:**
- `npu_required` — Job fails if NPU is not available. No fallback.
- `npu_preferred` — Prefer NPU; fall back to CPU if NPU unavailable. Requires same model, same preprocessing, same dimension, same embedding-space.
- `cpu_allowed` — CPU is acceptable. NPU preferred when available.
- `no_fallback` — No automatic fallback. Job fails if the primary device is unavailable.

**Fallback constraints:**
- CPU fallback is permitted only for the **exact same registered model**, preprocessing pipeline, vector dimension, and embedding-space ID.
- The job result records: `requested_device`, `actual_device`, `fallback_occurred` (boolean), `fallback_reason`.
- Fallback is not a silent substitution — it is logged and reported in the job result.

#### Hierarchical Fallback

Effective fallback is the **intersection** of three levels — each level may only make the policy stricter, never more permissive:

1. **Admin policy** (default): Set in `admin_openvino_fallback` — if this is `no_fallback`, all models and jobs are affected regardless of model or job settings.
2. **Model policy** (per `trusted_models.fallback_policy`): Applied on top of admin policy. Intersection: if admin says `npu_required` and model says `cpu_allowed`, effective is `npu_required`.
3. **Job policy** (per job contract `fallback_policy`): Applied on top of model policy. The job may only be stricter than the model profile's policy, never more permissive.

**Intersection matrix example:**

| Admin | Model | Job (requested) | Effective |
|-------|-------|-----------------|-----------|
| `cpu_allowed` | `npu_preferred` | `cpu_allowed` | `npu_preferred` |
| `cpu_allowed` | `cpu_allowed` | `npu_required` | `npu_required` |
| `npu_required` | `cpu_allowed` | `cpu_allowed` | `npu_required` |
| `no_fallback` | `cpu_allowed` | `cpu_allowed` | `no_fallback` |

The effective policy is computed at job scheduling time, before the job reaches the executor.

### 9. Job Contract Extension

The job contract in `src/compute/job-contract.js` is extended to accept:

```text
type: "text_embedding"
executor: "openvino.text_embedding"
```

Input schema (model limits come from the registered profile, not from the job):

```json
{
  "model": "<registered-model-id>",
  "input": ["text1", "text2"],
  "normalize": true,
  "fallback_policy": "cpu_allowed"
}
```

Output schema:

```json
{
  "embeddings": [[0.1, 0.2, ...], [0.3, 0.4, ...]],
  "model": "<model-id>",
  "dimensions": 512,
  "device": "NPU",
  "fallback_occurred": false,
  "fallback_reason": null,
  "usage": {
    "prompt_tokens": 24,
    "total_tokens": 24
  }
}
```

The `dimensions` field is determined by the model, not by the caller. The job contract rejects jobs that exceed the model's declared limits (sequence length, batch size).

### 10. Capability Router Integration

The capability router gains NPU-aware selection:

- `selectProvider()` matches `openvino.text_embedding` executor type.
- `selectWorker()` considers NPU certification state, current load, and concurrency limits.
- Routing rules can specify `data_classification: "internal"` or `"private"` for NPU workloads.
- Trust level `trusted` required for NPU executor.
- Workers only advertise NPU capability when the specific model/device/runtime combination is `ready` (not merely `detected`).

### 11. Dashboard Integration

The existing Compute page dashboard is extended to show:

- NPU device status with certification state (unknown, probing, unavailable, detected_unvalidated, detected_validated, quarantined, etc.) and structured reason.
- Model certification status per device.
- `openvino.text_embedding` jobs in the job list with device, fallback, and certification indicators.
- Fallback occurrence highlighted in job details.

### 12. OpenVINO Version as Tested Development Release

OpenVINO 2026.2.1 is currently identified by official distribution documentation as a development/non-LTS release. This is noted as a production risk.

**Mitigation:**
- Pin the exact version and document the reason (NPU support may only work on this version).
- Monitor OpenVINO release notes for NPU support changes.
- Define certification invalidation: any OpenVINO version change invalidates existing certifications.
- Rollback: if a newer version breaks NPU support, pin to the last working version.
- Document the risk in the model certification record.

## Compatibility Spike

A disposable `openvino-node` compatibility spike must be written and run on the target Windows 11 host before selecting the production architecture. The spike is not production code — it may be deleted after results are recorded.

### Spike Acceptance Criteria

The spike must produce a structured report (pass/fail with evidence) for each criterion:

1. **NPU enumeration:** `core.getAvailableDevices()` returns the NPU device (e.g., `NPU` or `Intel.NPU`).
2. **Device properties:** `core.getProperty(deviceName, propertyName)` returns usable device properties (name, driver version, supported precision, device ID) without error.
3. **Exact model loading:** Load a CLAP text encoder IR model from a known path using `core.readModel(modelPath)` or `core.readModelSync(modelPath)`. The path must be the NPU-validated IR from the Python validation.
4. **Explicit NPU compilation:** `core.compileModelSync(model, "NPU")` succeeds and returns a `CompiledModel`. (Note: `compileModelSync` is the synchronous variant; `compileModel` returns a `Promise<CompiledModel>`.)
5. **Tokenization parity:** `input_ids` and `attention_mask` for a set of test texts match the Python tokenizer output exactly (integer-for-integer).
6. **CPU+NPU numerical parity:** One source `Model` from `readModelSync`; two separate `CompiledModel` instances — one compiled for `"CPU"`, one for `"NPU"`. Identical preprocessed input tensors fed to both. Compare both outputs against the existing Python CPU reference. CPU and NPU outputs must each have cosine similarity ≥ 0.999 with the Python reference.
7. **All batch profiles tested:** Batch sizes 1, 2, 8, 16, 32 — record each as supported, unsupported, or not tested based on actual results. Do not advertise batch 32 merely because the spike attempts it.
8. **Stable repeated inference:** 100 consecutive `infer()` calls on NPU do not crash, degrade in quality, or trigger driver timeout.
9. **Clean startup and shutdown:** Release JavaScript references (let variables go out of scope). Run `global.gc()` if Node is launched with `--expose-gc`. Measure process memory across repeated load/inference/unload cycles. Verify that the process exits cleanly (exit code 0, no orphaned threads or leaked handles). Do not assume `Core`, `Model`, `CompiledModel`, or `InferRequest` have explicit `close()`, `dispose()`, or `delete()` methods — they do not in the `openvino-node` 2026.2.1 API.
10. **Timeout and cancellation behavior:** Run this experiment in a separate sacrificial child process with a hard parent-enforced timeout (e.g., 30s wall-clock). The parent kills the child tree if it exceeds the timeout. Test that a `Promise.race` with a 5-second timeout against a stuck native `infer()` does **not** interrupt the native call — the JavaScript side times out while the native call continues consuming worker capacity. Record the actual behavior: does the `Promise` reject? Does the native call eventually complete? Does the process become unusable afterward?
11. **Malformed model and crash containment:** Test in a separate sacrificial child process: load a malformed or incompatible IR (e.g., wrong input shape, deleted weights file, corrupted XML). Expect a controlled exception, not a process crash. Also test that child-process termination (SIGTERM / `taskkill`) against a hung native inference successfully terminates the process tree and does not affect the parent spike harness, Sidekick server, or unrelated workers.
12. **Reproducible on clean Windows:** The spike must run on a clean checkout with only `npm install` and the NPU driver + runtime installed — no special PATH, no Python, no custom DLLs in the project directory.

### Spike Report Structure

If the spike passes all criteria, the production architecture uses in-process `openvino-node`. If criterion 10 (cancellation) fails but all others pass, the architecture uses a helper process with termination support. If criteria 1, 3, 4, 5, or 12 fail, the architecture must use a separate Python helper process or another approach.

Child-process experiments (criteria 10 and 11) must be run in sacrificial child processes with hard parent-enforced timeout and tree termination. The parent spike harness must record exit code, signal, timeout status, bounded stdout, and bounded stderr for each child experiment.

The spike must record the exact `openvino-node` package version from `package.json` and the runtime version from `core.getVersions(deviceName)`. If the runtime version differs from the package version, note the discrepancy in the report.

## Consequences

### Positive

- NPU hardware is exposed through the existing, audited Sidekick Compute protocol.
- No new network listeners are introduced.
- Model integrity verified by hash for every file in the model.
- Input limits are model-specific, not generic — prevents shape mismatches and OOM.
- Existing worker enrollment, heartbeat, lease, and cancellation infrastructure reused.
- Dashboard shows NPU certification status without a separate management interface.
- Job contract validation catches malformed requests before they reach the inference path.
- Fallback policy is explicit and auditable.
- Device and certification states are granular and auditable.
- CLAP audio denial is enforced at multiple layers.

### Negative

- `openvino-node` adds ~200-400MB to the worker deployment size (native addon + runtime).
- Model files must be provisioned and certified before first use.
- This initial implementation targets native Windows only. OpenVINO supports other platforms but they are not validated here.
- CLAP audio encoder confirmed incompatible with NPU — only text encoder validated. Future models must be individually validated.
- OpenVINO 2026.2.1 is a development release, not LTS. Version pinning adds maintenance burden.
- In-process OpenVINO means an OpenVINO crash takes down the worker (mitigated by process supervision).

### Risks

- OpenVINO native code may have memory-safety bugs. Mitigated by: process supervision, restricted model loading, no network exposure, lease-based timeout.
- NPU driver updates could affect model performance or compatibility. Mitigated by: certification invalidation on driver change, hash-verified model files.
- `openvino-node` version changes could break NPU support. Mitigated by: version pinning, explicit certification invalidation.
- Model provisioning requires manual administrator action. This is intentional — security over convenience.

### Attack Surface (Accurate Assessment)

The OpenVINO integration adds the following local attack surface within the worker process:

1. **Native runtime code:** OpenVINO's C++ runtime and `openvino-node` native addon execute in the worker process via the selected in-process architecture. Bugs in these could be exploited if an attacker can influence model loading.
2. **Model loading:** An attacker who can write to the trusted model store could load a malicious model. Mitigated by: trusted store ACLs, hash verification, path canonicalization, administrative provisioning.

These risks are bounded by: (a) no network listener is introduced — OpenVINO runs in-process with no IPC layer, (b) restricted model store, (c) administrative provisioning, (d) hash verification, (e) path canonicalization, and (f) existing process supervision.

## Alternatives Considered

1. **`openvino-node` (in-process, pending spike):** Official Node.js binding. Eliminates IPC complexity. Adds native addon dependency. Proposed for this initial implementation pending the compatibility spike.
2. **Bundled Python helper process:** A separate Python process communicating via JSON Lines over stdin/stdout. Provides crash isolation and hosts the already-validated Python runtime. Would be selected if `openvino-node` spike fails on NPU enumeration, model loading, inference parity, cancellation support, or tokenizer reproduction. Adds Python dependency, IPC protocol complexity, packaging complexity.
3. **Bundled native C++ helper executable:** A standalone C++ binary. Provides crash isolation. Rejected for initial implementation due to: cross-compilation complexity, separate build pipeline, packaging complexity.
4. **TCP socket between worker and helper:** Rejected — introduces network listener, port scanning risk, firewall complexity.
5. **gRPC between worker and helper:** Rejected — overkill for local IPC, adds dependency and attack surface.
6. **WSL-based OpenVINO execution:** Rejected per user requirement — worker must run natively on Windows.
