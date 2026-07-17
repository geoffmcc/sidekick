# ADR: Secure OpenVINO NPU Worker Integration

## Status

**Accepted — revision 4 — 2026-07-17.**

This revision accepts a production architecture based on the completed native-Windows compatibility, correctness, memory, performance, and retrieval spikes.

The accepted architecture is:

- a native Windows Sidekick Compute worker;
- one or more persistent, supervised Python OpenVINO helper child processes owned by that worker;
- Python 3.12.13 with OpenVINO 2026.2.1 pinned as the initially certified runtime;
- E5-small-v2 qINT8 on CPU as the fast bulk/default embedding executor;
- Qwen3-Embedding-0.6B INT8 on Intel NPU as the optional higher-quality/deep-search executor;
- same-model Qwen CPU fallback when explicitly allowed;
- separate E5 and Qwen embedding spaces;
- no production use of in-process `openvino-node` because its output path exhibited linear resident-memory growth;
- no NPU execution of the CLAP audio encoder.

This ADR supersedes revisions 1 through 3. Their spike plans remain useful as historical evidence, but their pending architecture choices are no longer authoritative.

## Context

Sidekick Compute already supports `ollama.inference` and `mock.inference` executors. The target worker is a Windows 11 x86-64 desktop with an NVIDIA RTX 5070 and an Intel NPU enumerated by OpenVINO as `NPU`, full name `Intel(R) AI Boost`.

The production worker must run natively on Windows. WSL remains the development environment, but WSL is not an accepted production execution boundary for OpenVINO.

The goal is to add trusted local text-embedding executors without creating a separate enrolled NPU worker, exposing a network listener, allowing arbitrary model loading, or weakening the existing Compute job, lease, cancellation, result, and artifact boundaries.

## Measured Evidence

### Target runtime and hardware

The spike validated:

| Component | Measured value |
|---|---|
| Host | Windows 11 x86-64 |
| NPU | `Intel(R) AI Boost` |
| OpenVINO device name | `NPU` |
| Python | 3.12.13 |
| Python OpenVINO | 2026.2.1, build `2026.2.1-21919-ede283a88e3-releases/2026/2` |
| Node.js | 22.23.1 x64 |
| `openvino-node` runtime | 2026.2.1, same reported OpenVINO build |

The Python runtime enumerated `CPU`, `GPU`, and `NPU` directly through `ov.Core().available_devices`.

### `openvino-node`: functionally compatible but rejected for production

`openvino-node` successfully loaded, statically reshaped, compiled, and ran Qwen3-Embedding-0.6B INT8 on both CPU and NPU.

| Profile | CPU warm median | NPU warm median | CPU/NPU cosine |
|---|---:|---:|---:|
| `[1,128]` | 74.794 ms | 56.568 ms | 0.999270052336 |
| `[1,512]` | 324.630 ms | 272.656 ms | 0.999235198654 |

However, the Node binding retained approximately one output-sized native allocation per inference:

- `[1,128]`: about 51.92 MB RSS growth over 100 runs, matching roughly 100 × 0.5 MiB outputs;
- `[1,512]`: about 104.58 MB RSS growth over 50 runs, matching roughly 50 × 2 MiB outputs;
- forced garbage collection did not stop the growth;
- explicitly pre-binding and reusing one output tensor did not stop the growth;
- the same behavior occurred on CPU and NPU.

Because the growth is linear and occurs in a long-lived native execution path, in-process `openvino-node` is rejected for production even though model execution and numerical correctness passed.

### Python OpenVINO: accepted runtime

The equivalent Python OpenVINO test remained flat:

| Device | Profile | Iterations | RSS growth |
|---|---|---:|---:|
| CPU | `[1,512]` | 50 | 0.52 MB |
| NPU | `[1,512]` | 50 | 0.04 MB |

Sustained tests also remained flat:

| Model/device/profile | Iterations | End-to-end median | p95 | Throughput | RSS growth |
|---|---:|---:|---:|---:|---:|
| E5-small-v2 qINT8 / CPU / `[1,512]` | 1,000 | 15.026 ms | 22.614 ms | 62.915/s | 0.06 MB |
| Qwen3 INT8 / NPU / `[1,128]` | 500 | 57.614 ms | 58.843 ms | 17.349/s | 0.06 MB |
| Qwen3 INT8 / NPU / `[1,512]` | 500 | 274.209 ms | 276.661 ms | 3.646/s | -0.03 MB |

Qwen NPU has a significant persistent footprint and cold compile cost:

- `[1,128]`: about 3.106 GB RSS and 19.37 seconds to compile;
- `[1,512]`: about 3.165 GB RSS and 20.88 seconds to compile.

Therefore Qwen must be persistent after startup and may be lazily started or explicitly prewarmed. It must not be spawned once per request.

### Real-text correctness

The accepted preprocessing pipelines passed real-text retrieval checks, exact tokenizer/mask parity, repeated-output stability, and CPU/NPU numerical comparisons.

#### Qwen3-Embedding-0.6B INT8

- left padding;
- query-side task instruction;
- no instruction on documents;
- `input_ids` and `attention_mask` forwarded unchanged;
- last-token pooling;
- L2 normalization;
- 1,024-dimensional output.

Measured results:

| Test | Minimum cosine | Ranking result |
|---|---:|---|
| CPU vs NPU, `[1,128]` | 0.999486684799 | passed |
| CPU vs NPU, `[1,512]` | 0.999423742294 | passed |
| Cross-device/profile worst case | 0.999412655830 | passed |

Queries and documents embedded with the certified 128- and 512-token profiles remained mutually compatible. CPU and NPU results also remained compatible within the same Qwen embedding space.

#### E5-small-v2 qINT8

- `query:` prefix for queries;
- `passage:` prefix for documents;
- right padding from the local tokenizer;
- attention-mask-aware mean pooling;
- L2 normalization;
- 384-dimensional output.

CPU/NPU real-text minimum cosine was 0.999240159988 and rankings passed, but CPU was materially faster than NPU. E5 is therefore certified for CPU in the initial implementation, not NPU.

### CLAP regression evidence

The prior CLAP validation remains binding:

- CLAP text encoder: approximately 8-9 ms on NPU versus approximately 20 ms on CPU, cosine similarity about 0.999996;
- CLAP audio encoder: unacceptable NPU correctness, approximately 0.59 cosine in the original validation and lower in a later test;
- CLAP audio on NPU is permanently denied unless a future ADR explicitly replaces this decision with new evidence.

### Preliminary retrieval bake-off

A 63-query documentation benchmark showed complementary E5 and Qwen behavior:

| Path | Recall@1 | Recall@5 | Recall@10 | MRR | nDCG@10 |
|---|---:|---:|---:|---:|---:|
| E5 CPU | 0.460317 | 0.761905 | 0.809524 | 0.574966 | 0.540967 |
| Qwen NPU | 0.428571 | 0.761905 | 0.841270 | 0.569763 | 0.561243 |
| RRF fusion | 0.460317 | 0.761905 | 0.888889 | 0.587169 | 0.586365 |

The label audit found that many apparent misses were caused by narrow relevance labels, duplicate documentation, or query/label mismatch. These scores establish complementarity, not a permanent quality winner. Retrieval thresholds and automatic escalation rules require a corrected benchmark.

## Decision

### 1. Worker and helper boundary

OpenVINO runs in persistent supervised Python child processes owned by the native Windows Sidekick Compute worker.

The helper is not a separately enrolled worker. The existing worker remains the authority for:

- enrollment and authentication;
- capability advertisement;
- job claim and lease ownership;
- cancellation and deadlines;
- result and artifact submission;
- retries and recovery;
- audit logging.

The worker may run separate helper instances for independent executors so failure or restart of the optional Qwen NPU path does not remove E5, Ollama, or unrelated worker capacity.

The helper executable is launched by fixed absolute path from the installer-owned worker runtime. The worker must not use `PATH` lookup, a shell, `cmd.exe /c`, PowerShell command interpolation, or caller-controlled executable paths.

### 2. Helper IPC and lifecycle

The helper communicates only over inherited local stdin/stdout using a strict bounded protocol. No TCP, UDP, named HTTP, gRPC, or externally reachable listener is introduced.

Protocol requirements:

- versioned message schema;
- unique request IDs;
- strict allowlisted actions;
- bounded line/frame size;
- bounded text count and payload size from the selected model profile;
- stdout reserved for protocol messages;
- logs written to bounded, redacted stderr or the worker logging channel;
- unknown fields rejected where they affect security or execution;
- malformed messages fail closed;
- one response per request;
- late responses from cancelled or expired jobs are discarded.

The helper is persistent because NPU compilation takes about 19-21 seconds. The worker may lazily start Qwen or prewarm it according to administrator policy.

The parent worker owns the hard deadline. Cooperative Python/OpenVINO cancellation may be attempted, but process-tree termination is the authoritative containment mechanism for a hung helper. A helper crash or timeout must not terminate the worker or another helper.

Initial certified concurrency is one in-flight inference per helper/model/profile. Higher concurrency, asynchronous request pools, or batch sizes greater than one require separate certification evidence.

Measured Python memory is stable, so routine per-job recycling is not required. The worker must still enforce an RSS ceiling, startup timeout, inference timeout, and bounded restart policy as defense in depth.

### 3. Runtime packaging and pinning

The initial certified helper runtime is:

- CPython 3.12.13 x86-64;
- OpenVINO 2026.2.1 exact build;
- NumPy and tokenizer dependencies pinned by lockfile and package manifest.

The runtime is bundled or provisioned as an installer-owned isolated environment. Production must not depend on a user-installed Python, global `PATH`, Scoop, `py.exe`, WSL, or an activated developer virtual environment.

`trust_remote_code` must always be `false`. Runtime model downloads are forbidden.

A runtime update requires re-certification. Certification context includes at least:

- helper package/version and source revision;
- Python version;
- OpenVINO package and core build;
- tokenizer library version;
- model and tokenizer manifests;
- preprocessing version;
- Windows build;
- device identity;
- NPU driver and compiler versions when available;
- device type;
- precision;
- static input profile;
- concurrency and batch profile.

### 4. Trusted model store and provisioning

`SIDEKICK_OPENVINO_MODELS_DIR` is the single authoritative model-store setting.

Default Windows location:

```text
%ProgramData%\Sidekick\openvino-models\
```

The trusted model store is written only by an explicit administrative provisioner or installer. The worker and helper require read access only.

Separate writable locations are used for:

```text
%ProgramData%\Sidekick\openvino-cache\
%ProgramData%\Sidekick\openvino-state\
```

Every runtime model path must be canonicalized and proven to remain inside the trusted store. Reject:

- `..` traversal;
- symlink, junction, or reparse-point escape;
- UNC paths;
- URLs;
- alternate data streams;
- null bytes;
- case-normalization escape;
- paths not present in the registered manifest.

The helper accepts a registered model ID, never an arbitrary caller-provided filesystem path.

### 5. Trusted model and certification records

Model identity and certification remain separate.

A trusted model record includes:

- immutable `model_id`;
- display name;
- upstream repository and pinned revision;
- license;
- precision and quantization;
- embedding-space ID;
- output dimensions;
- preprocessing specification and version;
- tokenizer configuration;
- supported device classes;
- static input profiles;
- allowed fallback policy;
- SHA-256 and size for every model, tokenizer, and configuration file;
- lifecycle status.

A certification record is specific to the exact model, manifest, preprocessing, device, runtime, OS, driver, precision, profile, batch, and concurrency context. It records:

- result and structured reason code;
- exact tokenizer and attention-mask parity;
- output shape and dimension;
- finite-value and norm checks;
- same-text cosine evidence;
- retrieval-ranking preservation;
- cold compile and warm latency evidence;
- sustained memory evidence;
- timeout and containment evidence;
- certification timestamp and actor.

Changing any certification input creates an unvalidated context. The previous record may remain as historical evidence but cannot authorize the new context.

### 6. Device and certification state

Device discovery and model certification are separate.

Device states:

```text
unknown
probing
unavailable
available
faulted
```

Certification states:

```text
unregistered
pending
ready
degraded
quarantined
deprecated
```

Structured reason codes include, at minimum:

```text
runtime_missing
device_not_found
device_property_failed
manifest_mismatch
path_escape
model_load_failed
compile_failed
unsupported_profile
tokenizer_mismatch
attention_mask_mismatch
shape_mismatch
non_finite_output
accuracy_below_threshold
ranking_regression
out_of_memory
timed_out
memory_growth_unbounded
helper_crashed
unsupported_model_device
policy_denied
```

A detected NPU is not advertised as usable until at least one exact model/profile certification is `ready` and the startup self-test passes.

### 7. Initially accepted model profiles

#### E5-small-v2 qINT8 CPU

```text
model: intfloat/e5-small-v2 qINT8 OpenVINO IR
device: CPU
batch: 1
static sequence: 512
query preprocessing: "query: " prefix
document preprocessing: "passage: " prefix
pooling: attention-mask-aware mean pooling
normalization: L2
output dimensions: 384
```

Inputs exceeding 512 tokens are rejected as `unsupported_profile` unless an explicit upstream chunking operation creates smaller records. Silent truncation is forbidden.

#### Qwen3-Embedding-0.6B INT8 NPU

```text
model: Qwen3-Embedding-0.6B INT8 OpenVINO IR
device: NPU
batch: 1
static sequences: 128 and 512
query preprocessing: certified task instruction + query text
document preprocessing: document text without query instruction
padding: left
pooling: last token
normalization: L2
output dimensions: 1024
```

Profile selection occurs after applying query/document formatting and tokenizing without truncation:

```text
1-128 tokens   -> [1,128]
129-512 tokens -> [1,512]
>512 tokens    -> reject as unsupported_profile or chunk explicitly upstream
```

The 128- and 512-token Qwen profiles may share one Qwen embedding collection because cross-profile and cross-device compatibility passed. Profile and device provenance must still be recorded.

#### Qwen3 CPU fallback

Qwen CPU fallback is allowed only with the same registered model, manifest, preprocessing, profile, precision, output dimension, and embedding-space ID.

Cross-model fallback from Qwen to E5, or E5 to Qwen, is forbidden because the vector dimensions and semantic spaces differ.

#### BGE-small-en-v1.5

BGE is not part of the initially accepted production set. It may be evaluated later through the same certification framework.

#### CLAP

CLAP text may be exposed only through its own exact registered model/profile certification. CLAP audio requests targeting NPU are rejected before helper execution.

### 8. Job contract

The OpenVINO embedding job contract includes only allowlisted fields, including:

```json
{
  "executor": "openvino.text_embedding",
  "model_id": "registered-model-id",
  "input_kind": "query|document",
  "text": "bounded text",
  "fallback": "none|same_model_cpu",
  "deadline_ms": 30000
}
```

Exact field names may follow existing Sidekick conventions, but these semantics are binding.

The contract must not permit callers to set:

- helper executable path;
- model filesystem path;
- OpenVINO endpoint;
- arbitrary device strings;
- arbitrary tensor shapes;
- output dimensions;
- tokenizer or pooling implementation;
- runtime options not explicitly allowlisted;
- `trust_remote_code`;
- environment variables;
- cache or state paths.

The worker selects the certified static profile. A job may tighten fallback policy but may not loosen administrator or model policy.

Results include provenance and completion metadata:

- model ID and manifest hash;
- embedding-space ID and dimensions;
- device and fallback occurrence;
- static profile;
- runtime/core build;
- preprocessing version;
- normalized flag;
- compile/warm state;
- inference duration;
- completion/failure reason.

Unexpected empty, malformed, non-finite, wrong-shape, or wrong-dimension output is a failed or incomplete job, never a successful empty result.

### 9. Capability advertisement and routing

The worker advertises only exact ready capabilities, for example:

```text
openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1
openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq128:batch1
openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq512:batch1
openvino.text_embedding:qwen3-embedding-0.6b-int8:CPU:seq128:batch1
openvino.text_embedding:qwen3-embedding-0.6b-int8:CPU:seq512:batch1
```

The capability disappears or becomes unavailable when:

- startup self-test fails;
- the helper is unavailable beyond its bounded restart policy;
- the model manifest changes;
- the certification context becomes stale;
- the NPU disappears or faults;
- administrator policy disables it.

The scheduler routes to the existing Windows worker and then to the fit executor. The NPU is not represented as a separate worker identity.

### 10. Retrieval integration

E5 and Qwen vectors must use separate named vector fields or collections:

```text
E5: 384 dimensions
Qwen: 1024 dimensions
```

They share a stable document/chunk ID so ranked results can be combined.

The initial intended product policy is:

- lexical/FTS retrieval plus E5 CPU for routine retrieval;
- optional Qwen NPU retrieval for deep, comprehensive, ambiguous, architectural, or security-sensitive searches;
- reciprocal-rank fusion over stable IDs;
- never compare or average E5 and Qwen cosine scores directly.

The existing documentation benchmark supports complementarity but has label-quality defects. Automatic escalation thresholds and a permanent quality winner are deferred until the corrected benchmark includes broader relevance labels, source-authority metadata, and a lexical baseline.

### 11. Dashboard and diagnostics

The Compute dashboard exposes:

- helper runtime state;
- detected OpenVINO devices;
- exact ready model/profile capabilities;
- certification state and reason;
- cold, warming, ready, degraded, and quarantined status;
- compile and warm-up duration;
- current RSS and configured ceiling;
- active request and queue counts;
- fallback occurrence;
- helper restart count and last exit reason;
- model, profile, device, and runtime provenance on job detail.

The dashboard must not expose secrets, arbitrary local paths, full model manifests containing sensitive installation details, or unbounded helper output.

## Security Requirements

The integration adds native OpenVINO and Python code, model parsing, local IPC, and privileged installer-managed files to the worker attack surface.

Required mitigations:

- no network listener;
- no shell invocation;
- fixed absolute helper path;
- isolated child process boundary;
- strict IPC schema and message limits;
- process-tree kill on timeout;
- read-only trusted model store for the worker/helper;
- explicit administrative provisioning;
- complete file hashing;
- canonical path containment;
- local tokenizer files only;
- `trust_remote_code=false`;
- bounded concurrency;
- bounded restart policy;
- redacted logs;
- no runtime model download;
- no arbitrary OpenVINO options;
- deny unsupported model/device pairs before helper execution.

An attacker able to modify the installer-owned runtime or trusted model store is already across a high-trust local administrative boundary. Sidekick must still detect manifest changes and refuse certification rather than silently loading modified files.

## Consequences

### Positive

- The Intel NPU becomes useful for certified embedding workloads without occupying the RTX 5070.
- Existing Sidekick Compute enrollment, scheduling, leasing, cancellation, result, and dashboard boundaries are reused.
- Helper failure is isolated from the main worker and other executors.
- Python OpenVINO demonstrated stable memory under sustained load.
- E5 CPU provides high-throughput low-latency embeddings.
- Qwen NPU provides a complementary semantic path with certified 128- and 512-token profiles.
- No new network service is introduced.
- Models, preprocessing, devices, and runtime contexts are explicitly certified and auditable.

### Negative

- The worker package gains an isolated Python/OpenVINO runtime and tokenizer dependencies.
- Qwen NPU occupies about 3.1 GB RSS when loaded.
- Qwen NPU cold compilation takes about 19-21 seconds.
- Model provisioning and certification are administrative operations.
- The initial implementation supports native Windows only as a certified production target.
- Separate E5 and Qwen vector spaces increase indexing and storage cost when both are enabled.

### Operational risks

- OpenVINO, tokenizer, driver, compiler, or Windows updates may invalidate a certification.
- NPU availability can change after driver or firmware updates.
- A malformed but hash-approved model could still exercise a native runtime defect.
- Helper crashes or hangs require bounded restart and job recovery.
- Qwen startup may look stalled unless the worker reports an explicit warming state.
- Retrieval quality policy may change after the corrected benchmark.

## Alternatives Considered

1. **In-process `openvino-node` — rejected.** Model compatibility and speed passed, but resident memory grew linearly with output volume even after forced GC and output-tensor reuse. It also lacks an authoritative hard-cancellation boundary independent of the worker process.
2. **Supervised Python helper — accepted.** It reproduced correctness, supported native Windows NPU execution, remained memory-stable, and provides a killable process boundary.
3. **Native C++ helper — deferred.** It could reduce runtime size and overhead but adds a separate build, signing, packaging, and maintenance pipeline without a demonstrated need.
4. **Per-request Python process — rejected.** NPU compilation takes about 19-21 seconds, making per-request startup unacceptable.
5. **TCP or gRPC helper — rejected.** A network listener is unnecessary and increases attack surface and deployment complexity.
6. **WSL execution — rejected.** Production execution must be native Windows.
7. **E5 on NPU — rejected for the initial profile.** Correctness passed, but CPU was materially faster and lighter.
8. **One shared E5/Qwen vector space — rejected.** The models have different dimensions and semantic spaces.
9. **Silent truncation — rejected.** Inputs outside certified profiles must be explicitly chunked or rejected.

## Follow-up Work

Implementation should be split so the helper/runtime boundary lands before retrieval behavior changes:

1. supervised Python helper runtime, packaging, certification, model store, E5 CPU, Qwen NPU/CPU fallback, profile routing, capability advertisement, diagnostics, and tests;
2. lexical + E5 retrieval, separate Qwen vector space, optional deep retrieval, RRF, source-authority metadata, backfill/reindex controls, dashboard integration, and corrected quality benchmark.

A later ADR may replace the initial retrieval policy after a corrected benchmark. It must not weaken the runtime, certification, path-safety, or CLAP-audio denial decisions in this ADR without new measured evidence.
