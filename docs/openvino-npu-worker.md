# Sidekick OpenVINO NPU Integration

This document outlines the architecture, configuration, and security properties of the Sidekick OpenVINO NPU compute worker integration.

## Architecture Overview

The OpenVINO NPU worker integration adds native hardware-accelerated text embedding capabilities (e.g., E5-small-v2 on CPU and Qwen3-Embedding-0.6B on Intel NPU) to the Sidekick environment.

To adhere to the Sidekick architectural principles (Node.js primary environment) while ensuring predictable memory usage for ML inference, the integration operates across a secure process boundary:
1. **Sidekick Worker (Node.js)**: The primary worker process that manages job claims, validation, timeouts, and capability advertisement.
2. **OpenVINO Helper (Python)**: A persistent, supervised child process that compiles the model, handles OpenVINO/transformers inference, and returns results to the worker.

### Process Boundary and IPC
Communication between the Node.js worker and the Python helper occurs exclusively over `stdin` and `stdout` using a strict, versioned JSON protocol.
- **`stdout`** is strictly reserved for JSON protocol responses.
- **`stderr`** is used for structured logging and diagnostic output.
- No network listeners, gRPC endpoints, or shells are used.

## Configuration

The OpenVINO worker integration is disabled by default. An administrator must explicitly enable it and configure the authoritative paths.

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `SIDEKICK_OPENVINO_ENABLED` | Set to `"true"` to enable the executor. | `false` |
| `SIDEKICK_OPENVINO_PYTHON` | Absolute path to the isolated Python 3.12 environment executable. **Must be absolute.** | (None, required if enabled) |
| `SIDEKICK_OPENVINO_MODELS_DIR` | Absolute path to the read-only trusted model store. | `C:\ProgramData\Sidekick\openvino-models` |
| `SIDEKICK_OPENVINO_MAX_CONCURRENT`| Maximum concurrent inferences. Restricted to 1. | `1` |
| `SIDEKICK_OPENVINO_FALLBACK_POLICY`| Default fallback policy (`none` or `same_model_cpu`). | `none` |

## Model Allowlist (Manifest)

Sidekick enforces a strict allowlist of certified model profiles. The system rejects arbitrary paths or untrusted parameters.

Currently certified models:
1. **e5-small-v2-qint8**
   - Device: CPU Only
   - Profiles: 512 static sequence
   - Output Dimensions: 384
2. **qwen3-embedding-0.6b-int8**
   - Device: NPU (Primary), CPU (Fallback)
   - Profiles: 128, 512 static sequence
   - Output Dimensions: 1024

### Fallback Policy
Jobs can tighten, but not loosen, the fallback policy. If `SIDEKICK_OPENVINO_FALLBACK_POLICY` is `none`, requests to use CPU fallback when the NPU is busy or unavailable will be rejected.

## Security and Containment
- **Path Escape Prevention**: All paths must resolve safely within the authoritative model store. UNC paths, URLs, `..` traversals, and alternate data streams are blocked.
- **No Arbitrary Execution**: `trust_remote_code` is always explicitly `false`. Models are loaded `local_files_only=True`. The helper is invoked as an argument array without shell interpolation.
- **Resource Containment**:
  - `SIDEKICK_OPENVINO_STARTUP_TIMEOUT_MS` (Default: 60s)
  - `SIDEKICK_OPENVINO_INFERENCE_TIMEOUT_MS` (Default: 120s)
  - Memory bounds are monitored by the worker. If the helper process hangs, it is terminated via process tree SIGKILL (or `taskkill /T /F` on Windows).

## Production Windows Setup

Do not rely on the spike directory. Instead, provision a strict, reproducible environment:

1. Install **Python 3.12.13** (64-bit) for Windows.
2. Open an Administrator PowerShell and create a new virtual environment:
   ```powershell
   cd C:\ProgramData\Sidekick
   python -m venv openvino-env
   ```
3. Activate and install pinned dependencies:
   ```powershell
   .\openvino-env\Scripts\Activate.ps1
   # Use the exact pinned versions specified in src/compute/openvino/requirements.txt
   pip install -r C:\path\to\sidekick\src\compute\openvino\requirements.txt
   ```
4. Set the worker configuration:
   - `SIDEKICK_OPENVINO_PYTHON=C:\ProgramData\Sidekick\openvino-env\Scripts\python.exe`
   - `SIDEKICK_OPENVINO_ENABLED=true`

## NPU Hardware Smoke Test

To guarantee that inference is genuinely offloaded to the NPU (and not silently
falling back to the CPU), run the local hardware smoke test. It drives the
**production** helper (`src/compute/openvino/helper.py`) directly over the same
versioned stdin/stdout JSON protocol that the Node worker uses. It does **not**
require a running Sidekick server or any network listener.

The smoke test is fail-closed:

- fallback is disabled by default (`--fallback none`), so a silent CPU execution
  fails the test;
- it fails unless the helper reports the required device (`NPU` by default);
- it fails if a fallback occurred, if the embedding is empty/non-numeric/
  non-finite, or if the dimension does not match the model.

### Prerequisites

- The isolated Python 3.12 environment with the pinned packages from
  `src/compute/openvino/requirements.txt`.
- A trusted model store containing a directory named exactly after the model id,
  e.g. `<models-dir>\qwen3-embedding-0.6b-int8\` with `openvino_model.xml`,
  `openvino_model.bin`, and the local tokenizer files.

### Run (PowerShell wrapper)

```powershell
.\scripts\openvino-npu-smoke.ps1 `
    -Python 'C:\ProgramData\Sidekick\openvino-env\Scripts\python.exe' `
    -ModelsDir 'C:\ProgramData\Sidekick\openvino-models'
```

### Run (Python directly)

```powershell
& 'C:\ProgramData\Sidekick\openvino-env\Scripts\python.exe' `
    src\compute\openvino\smoke_test.py `
    --python 'C:\ProgramData\Sidekick\openvino-env\Scripts\python.exe' `
    --models-dir 'C:\ProgramData\Sidekick\openvino-models' `
    --model-id qwen3-embedding-0.6b-int8
```

### Validation

The smoke test prints the model id, requested device, actual device, fallback
status and reason, embedding dimension, timing, and total time, and it exits:

- `0` — real inference ran on the required device with a valid embedding;
- `1` — the response failed validation (wrong device, fallback occurred, bad
  embedding, wrong dimension);
- `2` — a setup/protocol error (paths missing, helper crashed, timeout).

The first NPU request compiles the model and can take ~20 seconds (cold), which
is why the default inference timeout is generous.

The validation logic itself is covered by hardware-independent unit tests in
`test/test_openvino_smoke.py`.

## Troubleshooting

1. **Helper Exits with Code 1**
   - Check the worker logs for `[helper]` log entries. The models directory may not exist or OpenVINO dependencies may be missing from the Python environment.
2. **Inference Timeouts**
   - NPU compilation can take ~20 seconds on cold start. Ensure `startupTimeoutMs` is adequate.
3. **`unsupported_profile` Errors**
   - Inputs exceeding the maximum certified sequence length (e.g., 512 tokens) must be chunked by the caller. The worker explicitly rejects silent truncation.
