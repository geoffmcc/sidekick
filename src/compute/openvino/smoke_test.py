#!/usr/bin/env python3
"""
Sidekick OpenVINO NPU hardware smoke test
=========================================

Local, hardware-facing smoke test that drives the *production* helper
(``helper.py``) over its real versioned stdin/stdout JSON protocol — the same
protocol the Node ``HelperManager`` uses.  It does not require a running
Sidekick server, a network listener, or any invented HTTP route.

Purpose: prove that an embedding genuinely executes on the Intel NPU and is not
silently served by the CPU.

The test is fail-closed:

  * fallback is disabled by default (``--fallback none``);
  * it fails unless the helper reports the required device (default ``NPU``);
  * it fails if a fallback occurred;
  * it fails if the embedding is empty, non-numeric, non-finite, or the wrong
    dimension for the model.

Security notes:

  * The helper is spawned with an argument array and ``shell=False``.
  * The Python executable and model-store directory are operator-controlled
    absolute paths; nothing is taken from an untrusted job.
  * The full embedding and any long input text are not printed unless
    ``--show-embedding`` / ``--show-text`` are passed.

Exit code is 0 only when every check passes; any failure returns non-zero.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

# Protocol version must match helper.py PROTOCOL_VERSION.
PROTOCOL_VERSION = "1"

# Expected embedding dimensions per certified model (mirrors the manifest).
EXPECTED_DIMENSIONS = {
    "e5-small-v2-qint8": 384,
    "qwen3-embedding-0.6b-int8": 1024,
}

DEFAULT_MODEL_ID = "qwen3-embedding-0.6b-int8"
DEFAULT_TEXT = "Smoke test: verify Intel NPU embedding execution."


# ---------------------------------------------------------------------------
# Hardware-independent validation logic (unit tested separately)
# ---------------------------------------------------------------------------

def validate_embedding_response(
    response: Any,
    *,
    model_id: str,
    required_device: str,
    expect_dim: int | None,
    allow_fallback: bool,
) -> list[str]:
    """Return a list of human-readable validation errors (empty == pass).

    Pure and side-effect free so it can be unit tested without hardware.
    """
    errors: list[str] = []

    if not isinstance(response, dict):
        return ["Helper response is not a JSON object"]

    if response.get("ok") is not True:
        code = response.get("error_code", "unknown")
        message = response.get("error", "")
        return [f"Helper returned an error: [{code}] {message}"]

    if response.get("action") != "embed":
        errors.append(
            f"Unexpected response action {response.get('action')!r}; expected 'embed'"
        )

    if response.get("model_id") != model_id:
        errors.append(
            f"Response model_id {response.get('model_id')!r} != requested {model_id!r}"
        )

    device = response.get("device")
    if device != required_device:
        errors.append(
            f"Actual device {device!r} != required {required_device!r} "
            "(the embedding did not run on the required hardware)"
        )

    fallback_occurred = bool(response.get("fallback_occurred"))
    if fallback_occurred and not allow_fallback:
        reason = response.get("fallback_reason")
        errors.append(
            f"Fallback occurred (reason={reason!r}) but fallback is disabled"
        )

    embedding = response.get("embedding")
    if not isinstance(embedding, list) or len(embedding) == 0:
        errors.append("Embedding is empty or missing")
    else:
        if expect_dim is not None and len(embedding) != expect_dim:
            errors.append(
                f"Embedding dimension {len(embedding)} != expected {expect_dim}"
            )
        bad = _first_bad_value(embedding)
        if bad is not None:
            index, value = bad
            errors.append(
                f"Embedding contains a non-numeric or non-finite value at "
                f"index {index}: {value!r}"
            )

    return errors


def _first_bad_value(values: list[Any]) -> tuple[int, Any] | None:
    """Return (index, value) of the first non-numeric/non-finite entry, else None."""
    for index, value in enumerate(values):
        # bool is a subclass of int; reject it explicitly.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return (index, value)
        if not math.isfinite(value):
            return (index, value)
    return None


# ---------------------------------------------------------------------------
# Helper process driver
# ---------------------------------------------------------------------------

class HelperError(RuntimeError):
    pass


def _resolve_paths(python_exe: str, models_dir: str, helper_script: str | None) -> tuple[Path, Path, Path]:
    py = Path(python_exe)
    if not py.is_absolute():
        raise HelperError(f"--python must be an absolute path, got {python_exe!r}")
    if not py.is_file():
        raise HelperError(f"Python executable not found: {py}")

    store = Path(models_dir)
    if not store.is_absolute():
        raise HelperError(f"--models-dir must be an absolute path, got {models_dir!r}")
    if not store.is_dir():
        raise HelperError(f"Model store directory not found: {store}")

    if helper_script:
        script = Path(helper_script)
    else:
        script = Path(__file__).resolve().parent / "helper.py"
    if not script.is_file():
        raise HelperError(f"Helper script not found: {script}")

    return py, store, script


def _pump_stderr(pipe, sink: list[str]) -> None:
    for raw in iter(pipe.readline, ""):
        line = raw.rstrip("\n")
        if line:
            sink.append(line)
            print(f"[helper] {line}", file=sys.stderr, flush=True)
    try:
        pipe.close()
    except Exception:
        pass


def _read_json_line(pipe, deadline: float) -> dict[str, Any]:
    """Read one JSON object from the helper stdout, respecting a wall-clock deadline."""
    while True:
        if time.monotonic() > deadline:
            raise HelperError("Timed out waiting for a helper protocol message")
        raw = pipe.readline()
        if raw == "":
            raise HelperError("Helper closed stdout before responding")
        line = raw.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError as exc:
            raise HelperError(f"Non-JSON line on helper stdout: {exc}: {line[:200]!r}")


def run_smoke(args: argparse.Namespace) -> int:
    py, store, script = _resolve_paths(args.python, args.models_dir, args.helper_script)

    expect_dim = EXPECTED_DIMENSIONS.get(args.model_id)
    if expect_dim is None and not args.allow_unknown_model:
        raise HelperError(
            f"Model {args.model_id!r} is not a known certified model. "
            f"Known: {sorted(EXPECTED_DIMENSIONS)}. Use --allow-unknown-model to override."
        )

    child_env = {
        "SIDEKICK_OPENVINO_MODELS_DIR": str(store),
        # Enforce offline model/tokenizer loading (mirrors the Node manager).
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
    }
    # Pass through only the Windows/OpenVINO runtime variables the driver needs.
    # USERPROFILE/HOMEDRIVE/HOMEPATH let "~" resolve so no stray cache dir is made.
    for key in (
        "PATH", "SYSTEMROOT", "WINDIR", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
        "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    ):
        if os.environ.get(key):
            child_env[key] = os.environ[key]

    print(
        f"Spawning helper: {py} -u {script}\n"
        f"  model store   : {store}\n"
        f"  model_id      : {args.model_id}\n"
        f"  input_kind    : {args.input_kind}\n"
        f"  required dev  : {args.required_device}\n"
        f"  fallback      : {args.fallback}",
        flush=True,
    )
    if args.show_text:
        print(f"  text          : {args.text!r}", flush=True)

    total_start = time.monotonic()
    proc = subprocess.Popen(
        [str(py), "-u", str(script)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=child_env,
        shell=False,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    stderr_lines: list[str] = []
    stderr_thread = threading.Thread(
        target=_pump_stderr, args=(proc.stderr, stderr_lines), daemon=True
    )
    stderr_thread.start()

    try:
        # 1. Wait for the "started" event.
        startup_deadline = time.monotonic() + (args.startup_timeout_ms / 1000.0)
        started = _read_json_line(proc.stdout, startup_deadline)
        if started.get("event") != "started":
            raise HelperError(f"Expected a 'started' event, got: {started}")
        if str(started.get("v")) != PROTOCOL_VERSION:
            raise HelperError(
                f"Protocol version mismatch: helper={started.get('v')!r}, "
                f"expected {PROTOCOL_VERSION!r}"
            )
        devices = started.get("available_devices", [])
        print(f"Helper started. OpenVINO devices: {devices}", flush=True)
        if args.required_device not in devices:
            raise HelperError(
                f"Required device {args.required_device!r} is not enumerated by "
                f"OpenVINO (available: {devices})"
            )

        # 2. Send the embed request.
        request_id = "smoke-1"
        request = {
            "v": PROTOCOL_VERSION,
            "id": request_id,
            "action": "embed",
            "model_id": args.model_id,
            "input_kind": args.input_kind,
            "text": args.text,
            "fallback": args.fallback,
        }
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()

        # 3. Await the matching response (inference may include cold NPU compile).
        infer_deadline = time.monotonic() + (args.inference_timeout_ms / 1000.0)
        response = None
        while True:
            msg = _read_json_line(proc.stdout, infer_deadline)
            if msg.get("event") == "fatal":
                raise HelperError(f"Helper emitted fatal error: {msg.get('error')}")
            if msg.get("id") == request_id:
                response = msg
                break
            # Ignore any unrelated line (there should be none at concurrency 1).

    finally:
        # 4. Terminate the helper cleanly: close stdin (EOF -> clean shutdown),
        #    then force-kill if it lingers.
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        stderr_thread.join(timeout=2)

    total_ms = (time.monotonic() - total_start) * 1000.0

    # 5. Validate.
    errors = validate_embedding_response(
        response,
        model_id=args.model_id,
        required_device=args.required_device,
        expect_dim=expect_dim,
        allow_fallback=(args.fallback != "none"),
    )

    _print_report(response, args, total_ms, expect_dim)

    if errors:
        print("\nSMOKE TEST FAILED:", flush=True)
        for err in errors:
            print(f"  - {err}", flush=True)
        return 1

    print("\nSMOKE TEST PASSED: real inference executed on the required device.", flush=True)
    return 0


def _print_report(
    response: Any,
    args: argparse.Namespace,
    total_ms: float,
    expect_dim: int | None,
) -> None:
    resp = response if isinstance(response, dict) else {}
    embedding = resp.get("embedding")
    dim = len(embedding) if isinstance(embedding, list) else None
    print("\n--- Result ---", flush=True)
    print(f"model_id          : {resp.get('model_id')}", flush=True)
    print(f"requested_device  : {resp.get('requested_device')}", flush=True)
    print(f"actual_device     : {resp.get('device')}", flush=True)
    print(f"fallback_occurred : {resp.get('fallback_occurred')}", flush=True)
    print(f"fallback_reason   : {resp.get('fallback_reason')}", flush=True)
    print(f"embedding_dim     : {dim} (expected {expect_dim})", flush=True)
    print(f"token_count       : {resp.get('token_count')}", flush=True)
    print(f"sequence_length   : {resp.get('sequence_length')}", flush=True)
    print(f"compile_ms        : {resp.get('compile_ms')}", flush=True)
    print(f"preprocess_ms     : {resp.get('preprocess_ms')}", flush=True)
    print(f"infer_ms          : {resp.get('infer_ms')}", flush=True)
    print(f"openvino_version  : {resp.get('openvino_version')}", flush=True)
    print(f"total_ms          : {round(total_ms, 1)}", flush=True)
    if args.show_embedding and isinstance(embedding, list):
        print(f"embedding[:8]     : {embedding[:8]}", flush=True)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Drive the production OpenVINO helper and prove NPU execution."
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Absolute path to the Python executable that runs the helper "
        "(default: the interpreter running this script).",
    )
    parser.add_argument(
        "--models-dir",
        required=True,
        help="Absolute path to the trusted model store (contains <model_id>/).",
    )
    parser.add_argument(
        "--helper-script",
        default=None,
        help="Override the helper.py path (default: sibling helper.py).",
    )
    parser.add_argument("--model-id", dest="model_id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--input-kind", default="query", choices=["query", "document"])
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument(
        "--required-device",
        default="NPU",
        help="Device the embedding MUST run on for the test to pass (default: NPU).",
    )
    parser.add_argument(
        "--fallback",
        default="none",
        choices=["none", "same_model_cpu"],
        help="Fallback policy sent to the helper (default: none / disabled).",
    )
    parser.add_argument("--startup-timeout-ms", type=int, default=120_000)
    parser.add_argument("--inference-timeout-ms", type=int, default=180_000)
    parser.add_argument(
        "--allow-unknown-model",
        action="store_true",
        help="Skip the known-dimension check for a non-catalogued model_id.",
    )
    parser.add_argument(
        "--show-embedding",
        action="store_true",
        help="Print the first few embedding values (off by default).",
    )
    parser.add_argument(
        "--show-text",
        action="store_true",
        help="Echo the input text (off by default to avoid leaking content).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run_smoke(args)
    except HelperError as exc:
        print(f"\nSMOKE TEST ERROR: {exc}", file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
