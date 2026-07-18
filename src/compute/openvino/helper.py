#!/usr/bin/env python3
"""
Sidekick OpenVINO NPU Embedding Helper
======================================

Persistent subprocess helper that accepts embedding requests from the
Sidekick Compute worker over stdin/stdout using a strict versioned JSON
protocol.

Security constraints (never relaxed at runtime):
  - No network listener.
  - No shell invocation.
  - No arbitrary model paths.  Model ID is resolved against the manifest
    passed at startup; caller-supplied paths are rejected.
  - trust_remote_code is always False.
  - No runtime model downloads.
  - stdout is reserved for protocol messages.
  - All diagnostic output goes to stderr.
  - Malformed or oversized messages fail closed.
  - Unknown action types are rejected.
  - Inline concurrency is 1.  The parent worker serialises requests.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Protocol constants
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "1"
HELPER_VERSION = "1.0.0"

# Maximum bytes for a single stdin line (64 KiB for the request envelope;
# text payloads within are bounded by the model profile).
MAX_LINE_BYTES = 65_536

# Maximum text length (characters) accepted for a single embedding input.
MAX_TEXT_CHARS = 32_768

# Maximum number of files that may be listed in the model manifest section.
MAX_MANIFEST_FILES = 256

ALLOWED_ACTIONS = frozenset({"embed", "ping", "ready"})
ALLOWED_INPUT_KINDS = frozenset({"query", "document"})
ALLOWED_FALLBACK_VALUES = frozenset({"none", "same_model_cpu"})
ALLOWED_MODELS = frozenset({
    "e5-small-v2-qint8",
    "qwen3-embedding-0.6b-int8",
})

# ---------------------------------------------------------------------------
# Stderr logging (never goes to stdout)
# ---------------------------------------------------------------------------

def _log(level: str, msg: str, **extra: Any) -> None:
    entry: dict[str, Any] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lvl": level,
        "msg": msg,
        **extra,
    }
    print(json.dumps(entry), file=sys.stderr, flush=True)

def _info(msg: str, **kw: Any) -> None:
    _log("INFO", msg, **kw)

def _warn(msg: str, **kw: Any) -> None:
    _log("WARN", msg, **kw)

def _error(msg: str, **kw: Any) -> None:
    _log("ERROR", msg, **kw)

# ---------------------------------------------------------------------------
# Stdout protocol responses (never mixed with log output)
# ---------------------------------------------------------------------------

def _send(obj: dict[str, Any]) -> None:
    """Emit a single-line JSON protocol message on stdout."""
    line = json.dumps(obj, separators=(",", ":"))
    print(line, flush=True)

def _reply_ok(request_id: str, payload: dict[str, Any]) -> None:
    _send({"v": PROTOCOL_VERSION, "id": request_id, "ok": True, **payload})

def _reply_err(request_id: str, code: str, message: str) -> None:
    # Truncate message to avoid leaking large internal errors.
    _send({
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "ok": False,
        "error_code": code,
        "error": message[:500],
    })

# ---------------------------------------------------------------------------
# Input validation helpers
# ---------------------------------------------------------------------------

def _require_str(obj: dict[str, Any], key: str, max_len: int = 512) -> str:
    val = obj.get(key)
    if not isinstance(val, str):
        raise ValueError(f"Field '{key}' must be a string")
    if len(val) > max_len:
        raise ValueError(f"Field '{key}' exceeds maximum length {max_len}")
    if "\0" in val:
        raise ValueError(f"Field '{key}' contains a null byte")
    return val

def _require_str_in(obj: dict[str, Any], key: str, allowed: frozenset[str]) -> str:
    val = _require_str(obj, key)
    if val not in allowed:
        raise ValueError(f"Field '{key}' value '{val}' not in allowed set {sorted(allowed)}")
    return val

def _optional_str_in(
    obj: dict[str, Any], key: str, allowed: frozenset[str], default: str
) -> str:
    if key not in obj:
        return default
    return _require_str_in(obj, key, allowed)

# ---------------------------------------------------------------------------
# Model state
# ---------------------------------------------------------------------------

class ModelState:
    """Holds the loaded/compiled OpenVINO model and its associated tokenizer."""

    def __init__(
        self,
        model_id: str,
        model_dir: Path,
        device: str,
        sequence_length: int,
        ov_core: Any,
        compiled_model: Any,
        infer_request: Any,
        tokenizer: Any,
        preprocessing_version: str,
        openvino_version: str,
        output_dimensions: int,
        embedding_space_id: str,
        compile_ms: float,
    ) -> None:
        self.model_id = model_id
        self.model_dir = model_dir
        self.device = device
        self.sequence_length = sequence_length
        self.ov_core = ov_core
        self.compiled_model = compiled_model
        self.infer_request = infer_request
        self.tokenizer = tokenizer
        self.preprocessing_version = preprocessing_version
        self.openvino_version = openvino_version
        self.output_dimensions = output_dimensions
        self.embedding_space_id = embedding_space_id
        self.compile_ms = compile_ms
        self.loaded_at = time.time()
        self.inference_count = 0

# ---------------------------------------------------------------------------
# Preprocessing implementations
# ---------------------------------------------------------------------------

def _e5_preprocess(
    text: str, input_kind: str, tokenizer: Any, sequence_length: int
) -> dict[str, Any]:
    """E5-small-v2: right-padded, mean-pooling, 384 dims."""
    import numpy as np
    prefix = "query: " if input_kind == "query" else "passage: "
    prefixed = prefix + text
    tokens = tokenizer(
        prefixed,
        padding="max_length",
        max_length=sequence_length,
        truncation=False,
        return_tensors="np",
    )
    # Reject inputs that required truncation (token count > sequence_length).
    # We ran without truncation so check if any token_id is non-pad beyond seq.
    raw_tokens = tokenizer(
        prefixed,
        truncation=False,
        return_tensors="np",
    )
    raw_len = int(raw_tokens["attention_mask"].sum())
    if raw_len > sequence_length:
        raise ValueError(
            f"Input tokenises to {raw_len} tokens which exceeds the "
            f"certified static profile of {sequence_length}"
        )
    input_ids = tokens["input_ids"].astype(np.int64)
    attention_mask = tokens["attention_mask"].astype(np.int64)
    return {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "raw_token_count": raw_len,
    }


# Certified Qwen3-Embedding query instruction.  This is the exact format
# proven by the accepted real-text correctness spike (and documented by the
# Qwen model card): "Instruct: <task>\nQuery:" concatenated directly with the
# query text (no trailing space).  Documents receive no instruction.
QWEN_TASK_INSTRUCTION = (
    "Instruct: Given a user query, retrieve the most relevant passage that "
    "answers the query or contains the needed technical information\nQuery:"
)


def _qwen_format(text: str, input_kind: str) -> str:
    return (QWEN_TASK_INSTRUCTION + text) if input_kind == "query" else text


def _qwen_preprocess(
    text: str, input_kind: str, tokenizer: Any, sequence_length: int
) -> dict[str, Any]:
    """Qwen3-Embedding: left-padded, last-token pooling, 1024 dims.

    Queries receive the certified task instruction; documents do not.  The
    input is tokenised without truncation so oversized inputs are rejected
    rather than silently clipped.  The tokenizer is configured with
    ``padding_side='left'`` at load time so the final position always holds a
    real token, which is required by last-token pooling.
    """
    import numpy as np
    formatted = _qwen_format(text, input_kind)

    # Tokenize without padding/truncation first to detect overflow.
    raw_tokens = tokenizer(
        formatted,
        truncation=False,
        return_tensors="np",
    )
    raw_len = int(raw_tokens["attention_mask"].sum())
    if raw_len > sequence_length:
        raise ValueError(
            f"Input tokenises to {raw_len} tokens which exceeds the "
            f"certified static profile of {sequence_length}"
        )

    tokens = tokenizer(
        formatted,
        padding="max_length",
        max_length=sequence_length,
        truncation=False,
        return_tensors="np",
    )
    input_ids = tokens["input_ids"].astype(np.int64)
    attention_mask = tokens["attention_mask"].astype(np.int64)
    # Fail closed if left-padding did not leave a real token in the final
    # position: last-token pooling would otherwise read a padding vector.
    if input_ids.shape != (1, sequence_length):
        raise ValueError(
            f"Unexpected tokenised shape {input_ids.shape}; "
            f"expected (1, {sequence_length})"
        )
    if int(attention_mask[0, -1]) != 1:
        raise RuntimeError(
            "Expected left-padding with a real final token, but "
            "attention_mask[-1] != 1"
        )
    return {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "raw_token_count": raw_len,
    }


# ---------------------------------------------------------------------------
# Pooling implementations
# ---------------------------------------------------------------------------

def _e5_pool(hidden: Any, attention_mask: Any) -> Any:
    """Attention-mask-aware mean pooling."""
    import numpy as np
    hidden = np.asarray(hidden, dtype=np.float32)
    mask = np.asarray(attention_mask, dtype=np.float32)[..., None]
    # hidden is [1, seq, dim]; mask is [1, seq, 1]
    summed = (hidden * mask).sum(axis=1)
    count = mask.sum(axis=1).clip(min=1e-9)
    return (summed / count)[0]


def _qwen_pool(hidden: Any, attention_mask: Any) -> Any:
    """Last-token pooling for the certified left-padded Qwen profile.

    This mirrors the accepted spike's ``pool_last_token``.  With left-padding
    the last real token is always the final position, so we pool ``[:, -1, :]``.
    If the sequence is (unexpectedly) right-aligned we fall back to the
    mask-derived index so a padding position is never pooled.
    """
    import numpy as np
    hidden = np.asarray(hidden, dtype=np.float32)
    mask = np.asarray(attention_mask)
    if hidden.ndim != 3 or hidden.shape[0] != 1:
        raise RuntimeError(f"Unexpected hidden-state shape: {hidden.shape}")

    if bool(np.all(mask[:, -1] == 1)):
        pooled = hidden[:, -1, :]
    else:
        last_index = int(mask.sum(axis=1)[0]) - 1
        pooled = hidden[:, last_index, :]
    return pooled[0]


def _l2_normalize(vector: Any) -> Any:
    import numpy as np
    vector = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError(f"Invalid embedding norm: {norm}")
    return vector / norm


# ---------------------------------------------------------------------------
# Model loader
# ---------------------------------------------------------------------------

_MODEL_CONFIGS: dict[str, dict[str, Any]] = {
    "e5-small-v2-qint8": {
        "device": "CPU",
        "sequence_lengths": [512],
        "output_dimensions": 384,
        "embedding_space_id": "e5-small-v2",
        "preprocessing_version": "1",
        "preprocess": _e5_preprocess,
        "pool": _e5_pool,
        "fallback_device": None,  # No fallback for E5.
        "required_files": ["openvino_model.xml", "openvino_model.bin"],
    },
    "qwen3-embedding-0.6b-int8": {
        "device": "NPU",
        "sequence_lengths": [128, 512],
        "output_dimensions": 1024,
        "embedding_space_id": "qwen3-embedding-0.6b",
        "preprocessing_version": "1",
        "preprocess": _qwen_preprocess,
        "pool": _qwen_pool,
        "fallback_device": "CPU",
        "required_files": ["openvino_model.xml", "openvino_model.bin"],
    },
}


def _find_model_dir(models_dir: Path, model_id: str) -> Path:
    """Resolve and validate the model directory.

    Ensures the resolved path remains inside models_dir (no path traversal).
    """
    candidate = (models_dir / model_id).resolve()
    # Canonical containment check.
    try:
        candidate.relative_to(models_dir.resolve())
    except ValueError:
        raise ValueError(
            f"Model path escape detected: '{model_id}' resolves outside "
            f"the trusted model store"
        )
    if not candidate.is_dir():
        raise FileNotFoundError(
            f"Model directory not found: '{candidate}'.  "
            "Provision the model store before starting the helper."
        )
    return candidate


def _verify_required_files(model_dir: Path, required: list[str]) -> None:
    for fname in required:
        fpath = model_dir / fname
        if not fpath.is_file():
            raise FileNotFoundError(
                f"Required model file missing: '{fpath}'.  "
                "Re-run the provisioner to restore the model store."
            )


def _select_sequence_length(
    config: dict[str, Any], raw_token_count: int
) -> int:
    """Select the smallest certified static profile that fits the input."""
    for sl in sorted(config["sequence_lengths"]):
        if raw_token_count <= sl:
            return sl
    raise ValueError(
        f"Token count {raw_token_count} exceeds the largest certified "
        f"profile ({max(config['sequence_lengths'])}).  "
        "Reject or chunk the input upstream."
    )


def _load_tokenizer(model_id: str, models_dir: Path) -> Any:
    """Load a model's tokenizer WITHOUT compiling any OpenVINO model.

    Profile selection / token counting must never force a model compile: on the
    NPU a second compiled model of the same graph makes an already-resident one
    fail to execute (ZE_RESULT_ERROR_UNINITIALIZED).  Loading the tokenizer
    standalone keeps counting cheap and CPU-only.
    """
    from transformers import AutoTokenizer

    model_dir = _find_model_dir(models_dir, model_id)
    padding_side = "left" if model_id.startswith("qwen") else "right"
    tokenizer_kwargs: dict[str, Any] = {
        "local_files_only": True,
        "trust_remote_code": False,
        "use_fast": True,
    }
    if model_id.startswith("qwen"):
        # The certified Qwen tokenizer requires the mistral regex fix (proven by
        # the accepted real-text correctness spike).  Fall back with a warning if
        # an unexpected runtime rejects the keyword rather than failing the load.
        tokenizer_kwargs["fix_mistral_regex"] = True
    try:
        tokenizer = AutoTokenizer.from_pretrained(str(model_dir), **tokenizer_kwargs)
    except TypeError as exc:
        if "fix_mistral_regex" in tokenizer_kwargs:
            _warn(
                "Tokenizer runtime does not accept fix_mistral_regex; loading "
                "without it (tokenization may differ from the certified spike)",
                model_id=model_id,
                error=str(exc),
            )
            tokenizer_kwargs.pop("fix_mistral_regex", None)
            tokenizer = AutoTokenizer.from_pretrained(str(model_dir), **tokenizer_kwargs)
        else:
            raise
    tokenizer.padding_side = padding_side
    return tokenizer


def _load_model(
    model_id: str,
    models_dir: Path,
    sequence_length: int,
    device: str,
    ov_core: Any,
    tokenizer: Any = None,
) -> ModelState:
    """Load and compile a model for the given device and sequence length."""
    import openvino as ov

    config = _MODEL_CONFIGS[model_id]

    if sequence_length not in config["sequence_lengths"]:
        raise ValueError(
            f"Sequence length {sequence_length} not in certified profiles "
            f"{config['sequence_lengths']} for model '{model_id}'"
        )

    model_dir = _find_model_dir(models_dir, model_id)
    _verify_required_files(model_dir, config["required_files"])

    model_xml = model_dir / "openvino_model.xml"

    _info(
        "Loading model",
        model_id=model_id,
        device=device,
        seq=sequence_length,
        path=str(model_dir),
    )

    # Tokenizer is loaded standalone (never as a side effect of compiling), so
    # profile selection cannot force an extra NPU model compile.
    if tokenizer is None:
        tokenizer = _load_tokenizer(model_id, models_dir)

    # Read and reshape model.
    raw_model = ov_core.read_model(str(model_xml))

    # Find input port names robustly.
    def _get_port_name(port: Any) -> str:
        try:
            return port.get_any_name()
        except Exception:
            return port.names.pop() if port.names else ""

    def _find_input(model: Any, candidates: list[str]) -> Any:
        for inp in model.inputs:
            name = _get_port_name(inp)
            if name in candidates:
                return inp
        raise RuntimeError(
            f"Could not locate input port(s) {candidates} in model "
            f"'{model_id}'.  Available: "
            f"{[_get_port_name(p) for p in model.inputs]}"
        )

    ids_port = _find_input(raw_model, ["input_ids"])
    mask_port = _find_input(raw_model, ["attention_mask"])

    raw_model.reshape({
        ids_port: [1, sequence_length],
        mask_port: [1, sequence_length],
    })

    t_compile_start = time.perf_counter()
    compiled = ov_core.compile_model(raw_model, device)
    compile_ms = (time.perf_counter() - t_compile_start) * 1000.0

    _info(
        "Model compiled",
        model_id=model_id,
        device=device,
        seq=sequence_length,
        compile_ms=round(compile_ms, 1),
    )

    infer_request = compiled.create_infer_request()

    return ModelState(
        model_id=model_id,
        model_dir=model_dir,
        device=device,
        sequence_length=sequence_length,
        ov_core=ov_core,
        compiled_model=compiled,
        infer_request=infer_request,
        tokenizer=tokenizer,
        preprocessing_version=config["preprocessing_version"],
        openvino_version=ov.__version__,
        output_dimensions=config["output_dimensions"],
        embedding_space_id=config["embedding_space_id"],
        compile_ms=compile_ms,
    )


# ---------------------------------------------------------------------------
# Helper runtime
# ---------------------------------------------------------------------------

class HelperRuntime:
    """Manages loaded model states keyed by (model_id, device, sequence_length)."""

    def __init__(self, models_dir: Path, startup_config: dict[str, Any]) -> None:
        import openvino as ov
        self.models_dir = models_dir
        self.startup_config = startup_config
        self.ov_core = ov.Core()
        self._states: dict[tuple[str, str, int], ModelState] = {}
        self._tokenizers: dict[str, Any] = {}
        self._ov_version = ov.__version__

        available = self.ov_core.available_devices
        _info(
            "OpenVINO initialised",
            version=self._ov_version,
            devices=available,
        )
        self._available_devices = set(available)

    def _state_key(self, model_id: str, device: str, seq: int) -> tuple[str, str, int]:
        return (model_id, device, seq)

    def _get_tokenizer(self, model_id: str) -> Any:
        """Return a cached tokenizer for the model, loading it without any compile."""
        tok = self._tokenizers.get(model_id)
        if tok is None:
            tok = _load_tokenizer(model_id, self.models_dir)
            self._tokenizers[model_id] = tok
        return tok

    def _get_or_load(
        self, model_id: str, device: str, sequence_length: int
    ) -> ModelState:
        key = self._state_key(model_id, device, sequence_length)
        if key in self._states:
            return self._states[key]

        if device == "NPU":
            # The NPU cannot execute a compiled model while another profile of the
            # same graph is resident (a second compile makes the first raise
            # ZE_RESULT_ERROR_UNINITIALIZED at execute).  Evict and release any
            # other NPU-resident profile for this model before compiling a new one
            # so at most one NPU model is live at a time.
            stale = [k for k in self._states if k[0] == model_id and k[1] == "NPU"]
            for k in stale:
                del self._states[k]
            if stale:
                import gc
                gc.collect()

        state = _load_model(
            model_id=model_id,
            models_dir=self.models_dir,
            sequence_length=sequence_length,
            device=device,
            ov_core=self.ov_core,
            tokenizer=self._get_tokenizer(model_id),
        )
        self._states[key] = state
        return state

    def handle_ready(self, request_id: str, model_id: str) -> None:
        """
        Validate that the model store exists and contains required files,
        and that the device is available.  Does not compile or load.
        """
        if model_id not in ALLOWED_MODELS:
            _reply_err(request_id, "unsupported_model", f"Unknown model_id: '{model_id}'")
            return

        config = _MODEL_CONFIGS[model_id]
        target_device = config["device"]

        if target_device not in self._available_devices:
            _reply_err(
                request_id,
                "device_not_found",
                f"Device '{target_device}' not in available_devices "
                f"{sorted(self._available_devices)}",
            )
            return

        try:
            model_dir = _find_model_dir(self.models_dir, model_id)
            _verify_required_files(model_dir, config["required_files"])
        except (FileNotFoundError, ValueError) as exc:
            _reply_err(request_id, "model_load_failed", str(exc))
            return

        _reply_ok(request_id, {
            "action": "ready",
            "model_id": model_id,
            "device": target_device,
            "available_devices": sorted(self._available_devices),
            "openvino_version": self._ov_version,
            "helper_version": HELPER_VERSION,
            "certified_profiles": config["sequence_lengths"],
            "output_dimensions": config["output_dimensions"],
            "embedding_space_id": config["embedding_space_id"],
        })

    def handle_embed(self, request_id: str, payload: dict[str, Any]) -> None:
        import numpy as np

        model_id = _require_str_in(payload, "model_id", ALLOWED_MODELS)
        input_kind = _require_str_in(payload, "input_kind", ALLOWED_INPUT_KINDS)
        text = _require_str(payload, "text", MAX_TEXT_CHARS)
        fallback = _optional_str_in(
            payload, "fallback", ALLOWED_FALLBACK_VALUES, "none"
        )

        if not text.strip():
            _reply_err(request_id, "empty_input", "Input text is empty or whitespace-only")
            return

        config = _MODEL_CONFIGS[model_id]
        primary_device = config["device"]

        # --- Profile selection ---
        # Count tokens with the standalone tokenizer (no model compile) so we do
        # NOT compile an unused NPU profile just to select the sequence length.
        try:
            tokenizer = self._get_tokenizer(model_id)
            probe_tokens = tokenizer(text, truncation=False, return_tensors="np")
            raw_count = int(probe_tokens["attention_mask"].sum())
        except Exception as exc:
            _reply_err(request_id, "tokenizer_error", f"Tokenizer failed: {exc}")
            return

        try:
            sequence_length = _select_sequence_length(config, raw_count)
        except ValueError as exc:
            _reply_err(request_id, "unsupported_profile", str(exc))
            return

        # --- Device selection ---
        device = primary_device
        fallback_occurred = False
        fallback_reason: str | None = None

        if device not in self._available_devices:
            if fallback == "same_model_cpu" and config.get("fallback_device"):
                device = config["fallback_device"]
                fallback_occurred = True
                fallback_reason = f"device_not_found:{primary_device}"
                _warn(
                    "Primary device unavailable; falling back to CPU",
                    model_id=model_id,
                    primary_device=primary_device,
                    fallback_device=device,
                )
            else:
                _reply_err(
                    request_id,
                    "device_not_found",
                    f"Device '{device}' not available and fallback is '{fallback}'",
                )
                return

        # --- Load model ---
        try:
            state = self._get_or_load(model_id, device, sequence_length)
        except FileNotFoundError as exc:
            _reply_err(request_id, "model_load_failed", str(exc))
            return
        except Exception as exc:
            _reply_err(request_id, "compile_failed", f"Model compile/load failed: {exc}")
            return

        # --- Preprocess ---
        try:
            preprocess_fn = config["preprocess"]
            t_pre = time.perf_counter()
            processed = preprocess_fn(text, input_kind, state.tokenizer, sequence_length)
            preprocess_ms = (time.perf_counter() - t_pre) * 1000.0
        except ValueError as exc:
            _reply_err(request_id, "unsupported_profile", str(exc))
            return
        except Exception as exc:
            _reply_err(request_id, "tokenizer_error", f"Preprocessing failed: {exc}")
            return

        # --- Infer ---
        # Build input dictionary keyed by matching actual compiled input names.
        infer_inputs = {}
        for port in state.compiled_model.inputs:
            try:
                name = port.get_any_name()
                if "input_ids" in name:
                    infer_inputs[name] = processed["input_ids"]
                elif "attention_mask" in name:
                    infer_inputs[name] = processed["attention_mask"]
            except Exception:
                continue

        if len(infer_inputs) < 2:
            _reply_err(
                request_id,
                "shape_mismatch",
                f"Could not safely map input_ids and attention_mask by name. "
                f"Mapped ports: {list(infer_inputs.keys())}",
            )
            return

        try:
            t_infer = time.perf_counter()
            outputs = state.infer_request.infer(
                infer_inputs,
                share_inputs=False,
                share_outputs=False,
            )
            infer_ms = (time.perf_counter() - t_infer) * 1000.0
        except Exception as exc:
            _reply_err(request_id, "inference_failed", f"Inference failed: {exc}")
            return

        # --- Pool and normalize ---
        try:
            pool_fn = config["pool"]
            raw_output = next(iter(outputs.values()))
            hidden = np.asarray(raw_output, dtype=np.float32)
            pooled = pool_fn(hidden, processed["attention_mask"])
            embedding = _l2_normalize(pooled)
        except Exception as exc:
            _reply_err(request_id, "non_finite_output", f"Pooling/normalization failed: {exc}")
            return

        # --- Validate output ---
        if not np.all(np.isfinite(embedding)):
            _reply_err(
                request_id,
                "non_finite_output",
                f"Embedding contains non-finite values after normalization",
            )
            return

        if embedding.shape[0] != config["output_dimensions"]:
            _reply_err(
                request_id,
                "shape_mismatch",
                f"Output dimension {embedding.shape[0]} != "
                f"expected {config['output_dimensions']}",
            )
            return

        state.inference_count += 1

        _reply_ok(request_id, {
            "action": "embed",
            "model_id": model_id,
            "embedding_space_id": state.embedding_space_id,
            "dimensions": int(embedding.shape[0]),
            "embedding": embedding.tolist(),
            "device": device,
            "requested_device": primary_device,
            "fallback_occurred": fallback_occurred,
            "fallback_reason": fallback_reason,
            "sequence_length": sequence_length,
            "token_count": processed["raw_token_count"],
            "preprocess_ms": round(preprocess_ms, 3),
            "infer_ms": round(infer_ms, 3),
            "preprocessing_version": state.preprocessing_version,
            "openvino_version": state.openvino_version,
            "helper_version": HELPER_VERSION,
            "normalized": True,
            "compile_ms": round(state.compile_ms, 1),
            "inference_count": state.inference_count,
        })


# ---------------------------------------------------------------------------
# Main stdin/stdout event loop
# ---------------------------------------------------------------------------

def _read_line(timeout_hint: str = "") -> str | None:
    """Read a single line from stdin, enforcing max byte limit."""
    raw = sys.stdin.readline()
    if not raw:
        return None  # EOF
    if len(raw.encode("utf-8")) > MAX_LINE_BYTES:
        raise ValueError(
            f"Input line exceeds maximum size of {MAX_LINE_BYTES} bytes {timeout_hint}"
        )
    return raw.rstrip("\n")


def main() -> int:
    # ------------------------------------------------------------------
    # Startup configuration from environment
    # ------------------------------------------------------------------
    models_dir_env = os.environ.get("SIDEKICK_OPENVINO_MODELS_DIR", "")
    if not models_dir_env:
        _error(
            "SIDEKICK_OPENVINO_MODELS_DIR not set.  "
            "Set this to the absolute path of the trusted model store."
        )
        return 1

    models_dir = Path(models_dir_env).resolve()

    # Basic sanity: models_dir must exist and must not be a UNC or URL path.
    if not models_dir.is_dir():
        _error(
            "SIDEKICK_OPENVINO_MODELS_DIR does not exist or is not a directory",
            path=str(models_dir),
        )
        return 1

    # Reject obviously dangerous paths on Windows.
    raw_lower = models_dir_env.lower()
    if raw_lower.startswith("\\\\") or raw_lower.startswith("//"):
        _error("UNC model store paths are not allowed", path=models_dir_env)
        return 1

    # ------------------------------------------------------------------
    # Import OpenVINO — emit structured error if missing.
    # ------------------------------------------------------------------
    try:
        import openvino as ov  # noqa: F401
    except ImportError as exc:
        _error(
            "OpenVINO is not installed in this Python environment",
            error=str(exc),
            hint="Install the certified openvino package into the isolated runtime.",
        )
        return 1

    try:
        from transformers import AutoTokenizer  # noqa: F401
    except ImportError as exc:
        _error(
            "transformers library is not installed in this Python environment",
            error=str(exc),
            hint="Install transformers into the isolated runtime.",
        )
        return 1

    try:
        import numpy  # noqa: F401
    except ImportError as exc:
        _error(
            "NumPy is not installed in this Python environment",
            error=str(exc),
        )
        return 1

    # ------------------------------------------------------------------
    # Announce readiness on stderr.
    # ------------------------------------------------------------------
    _info(
        "Helper starting",
        protocol_version=PROTOCOL_VERSION,
        helper_version=HELPER_VERSION,
        models_dir=str(models_dir),
        python=sys.version.replace("\n", " "),
    )

    startup_config: dict[str, Any] = {
        "models_dir": str(models_dir),
    }

    try:
        runtime = HelperRuntime(models_dir=models_dir, startup_config=startup_config)
    except Exception as exc:
        _error("Failed to initialise HelperRuntime", error=str(exc))
        return 1

    # Emit startup-complete protocol message so the parent can detect the ready state.
    _send({
        "v": PROTOCOL_VERSION,
        "event": "started",
        "helper_version": HELPER_VERSION,
        "openvino_version": runtime._ov_version,
        "available_devices": sorted(runtime._available_devices),
        "models_dir": str(models_dir),
    })

    # ------------------------------------------------------------------
    # Main request loop.
    # ------------------------------------------------------------------
    while True:
        try:
            line = _read_line()
        except ValueError as exc:
            _error("Oversized stdin line", error=str(exc))
            # We cannot associate this with a request_id so emit a fatal error.
            _send({"v": PROTOCOL_VERSION, "event": "fatal", "error": str(exc)[:500]})
            return 1
        except Exception as exc:
            _error("Unexpected stdin read error", error=str(exc))
            return 1

        if line is None:
            _info("Stdin closed; shutting down cleanly")
            return 0

        line = line.strip()
        if not line:
            continue

        # Parse the request envelope.
        try:
            msg: dict[str, Any] = json.loads(line)
        except json.JSONDecodeError as exc:
            _error("Malformed JSON on stdin; cannot recover without request_id", error=str(exc))
            _send({"v": PROTOCOL_VERSION, "event": "fatal", "error": "malformed_json"})
            return 1

        request_id = msg.get("id", "")
        if not isinstance(request_id, str) or not request_id:
            _error("Message missing string 'id' field")
            _send({"v": PROTOCOL_VERSION, "event": "fatal", "error": "missing_request_id"})
            return 1

        # Check protocol version.
        msg_version = msg.get("v", "")
        if str(msg_version) != PROTOCOL_VERSION:
            _reply_err(
                request_id,
                "protocol_version_mismatch",
                f"Expected protocol version '{PROTOCOL_VERSION}', got '{msg_version}'",
            )
            continue

        action = msg.get("action", "")
        if action not in ALLOWED_ACTIONS:
            _reply_err(
                request_id,
                "unsupported_action",
                f"Unknown action '{action}'. Allowed: {sorted(ALLOWED_ACTIONS)}",
            )
            continue

        # Dispatch.
        try:
            if action == "ping":
                _reply_ok(request_id, {
                    "action": "ping",
                    "helper_version": HELPER_VERSION,
                    "openvino_version": runtime._ov_version,
                    "available_devices": sorted(runtime._available_devices),
                })
            elif action == "ready":
                model_id_raw = msg.get("model_id", "")
                if not isinstance(model_id_raw, str) or model_id_raw not in ALLOWED_MODELS:
                    _reply_err(
                        request_id,
                        "unsupported_model",
                        f"Unknown or missing model_id: '{model_id_raw}'",
                    )
                else:
                    runtime.handle_ready(request_id, model_id_raw)
            elif action == "embed":
                runtime.handle_embed(request_id, msg)
        except Exception as exc:
            _error(
                "Unhandled exception in request handler",
                action=action,
                request_id=request_id,
                error=str(exc),
                trace=traceback.format_exc()[-1000:],
            )
            _reply_err(request_id, "internal_error", "Internal helper error")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        _info("Helper interrupted")
        raise SystemExit(0)
