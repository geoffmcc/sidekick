#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np


def pump(stream, sink, capture: list[str]) -> None:
    try:
        for line in iter(stream.readline, ""):
            capture.append(line)
            sink.write(line)
            sink.flush()
    finally:
        stream.close()


def kill_tree(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(pid, 9)
        except Exception:
            pass


def run_child(
    python_exe: Path,
    child_script: Path,
    args: list[Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(
        [str(python_exe), str(child_script), *map(str, args)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        creationflags=creationflags,
        **kwargs,
    )

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    stdout_thread = threading.Thread(
        target=pump, args=(proc.stdout, sys.stdout, stdout_lines), daemon=True
    )
    stderr_thread = threading.Thread(
        target=pump, args=(proc.stderr, sys.stderr, stderr_lines), daemon=True
    )
    stdout_thread.start()
    stderr_thread.start()

    timed_out = False
    try:
        code = proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_tree(proc.pid)
        code = proc.wait(timeout=30)

    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)

    return {
        "code": code,
        "timed_out": timed_out,
        "stdout_tail": "".join(stdout_lines)[-65536:],
        "stderr_tail": "".join(stderr_lines)[-65536:],
    }


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 0 or not math.isfinite(denom):
        raise RuntimeError("Invalid vector norm during CPU/NPU comparison")
    return float(np.dot(a, b) / denom)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("sequence_length", type=int, nargs="?", default=512)
    parser.add_argument("timeout_ms", type=int, nargs="?", default=900000)
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    result_dir = here / "probe-results"
    result_dir.mkdir(exist_ok=True)
    child = here / "qwen-real-text-child.py"
    python_exe = Path(sys.executable).resolve()

    print(f"Python: {sys.version.split()[0]}")
    print(f"Model: {Path(args.model_dir).resolve()}")
    print(f"Static profile: [1,{args.sequence_length}]")
    print(f"Per-child hard timeout: {args.timeout_ms} ms")

    statuses: dict[str, Any] = {}
    for device in ("CPU", "NPU"):
        print(f"\n=== {device} ===", flush=True)
        child_result = run_child(
            python_exe,
            child,
            [
                Path(args.model_dir).resolve(),
                device,
                args.sequence_length,
                result_dir,
            ],
            max(1, args.timeout_ms // 1000),
        )
        status = (
            "timeout"
            if child_result["timed_out"]
            else ("pass" if child_result["code"] == 0 else "fail")
        )
        print(f"{device}_STATUS={status} CODE={child_result['code']}", flush=True)
        statuses[device] = {"status": status, **child_result}

    if any(entry["status"] != "pass" for entry in statuses.values()):
        summary = {
            "statuses": statuses,
            "comparison": None,
        }
        summary_path = result_dir / f"real-text-summary-{args.sequence_length}.json"
        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"\nSUMMARY={summary_path}")
        return 1

    cpu_path = result_dir / f"real-text-cpu-{args.sequence_length}.json"
    npu_path = result_dir / f"real-text-npu-{args.sequence_length}.json"
    cpu = json.loads(cpu_path.read_text(encoding="utf-8"))
    npu = json.loads(npu_path.read_text(encoding="utf-8"))

    cpu_embeddings = np.asarray(cpu["embeddings"], dtype=np.float32)
    npu_embeddings = np.asarray(npu["embeddings"], dtype=np.float32)

    if cpu_embeddings.shape != npu_embeddings.shape:
        raise RuntimeError(
            f"CPU/NPU embedding shape mismatch: {cpu_embeddings.shape} vs "
            f"{npu_embeddings.shape}"
        )

    per_text_cosines = [
        cosine(cpu_embeddings[i], npu_embeddings[i])
        for i in range(cpu_embeddings.shape[0])
    ]
    min_cosine = min(per_text_cosines)
    mean_cosine = float(np.mean(per_text_cosines))

    token_parity = True
    token_mismatches: list[int] = []
    for i, (cpu_record, npu_record) in enumerate(zip(cpu["records"], npu["records"])):
        keys = (
            "token_count",
            "input_ids_first_16",
            "input_ids_last_16",
            "attention_mask_first_16",
            "attention_mask_last_16",
        )
        if any(cpu_record[key] != npu_record[key] for key in keys):
            token_parity = False
            token_mismatches.append(i)

    official_matrix_delta = np.max(
        np.abs(
            np.asarray(cpu["official"]["scores"], dtype=np.float32)
            - np.asarray(npu["official"]["scores"], dtype=np.float32)
        )
    )
    sidekick_matrix_delta = np.max(
        np.abs(
            np.asarray(cpu["sidekick"]["scores"], dtype=np.float32)
            - np.asarray(npu["sidekick"]["scores"], dtype=np.float32)
        )
    )

    print(f"\nCPU_NPU_PER_TEXT_COSINES={json.dumps(per_text_cosines)}")
    print(f"CPU_NPU_MIN_COSINE={min_cosine:.12f}")
    print(f"CPU_NPU_MEAN_COSINE={mean_cosine:.12f}")
    print(f"TOKEN_PARITY={str(token_parity).lower()}")
    print(f"TOKEN_MISMATCH_INDICES={json.dumps(token_mismatches)}")
    print(f"OFFICIAL_SCORE_MATRIX_MAX_DELTA={official_matrix_delta:.12f}")
    print(f"SIDEKICK_SCORE_MATRIX_MAX_DELTA={sidekick_matrix_delta:.12f}")
    print(f"CPU_OFFICIAL_RANKING_PASS={str(cpu['official']['pass']).lower()}")
    print(f"NPU_OFFICIAL_RANKING_PASS={str(npu['official']['pass']).lower()}")
    print(f"CPU_SIDEKICK_RANKING_PASS={str(cpu['sidekick']['pass']).lower()}")
    print(f"NPU_SIDEKICK_RANKING_PASS={str(npu['sidekick']['pass']).lower()}")

    comparison_pass = (
        token_parity
        and min_cosine >= 0.999
        and cpu["official"]["pass"]
        and npu["official"]["pass"]
        and cpu["sidekick"]["pass"]
        and npu["sidekick"]["pass"]
    )

    summary = {
        "python": sys.version,
        "model_dir": str(Path(args.model_dir).resolve()),
        "sequence_length": args.sequence_length,
        "statuses": statuses,
        "comparison": {
            "per_text_cosines": per_text_cosines,
            "min_cosine": min_cosine,
            "mean_cosine": mean_cosine,
            "token_parity": token_parity,
            "token_mismatch_indices": token_mismatches,
            "official_score_matrix_max_delta": float(official_matrix_delta),
            "sidekick_score_matrix_max_delta": float(sidekick_matrix_delta),
            "cpu_official_ranking_pass": cpu["official"]["pass"],
            "npu_official_ranking_pass": npu["official"]["pass"],
            "cpu_sidekick_ranking_pass": cpu["sidekick"]["pass"],
            "npu_sidekick_ranking_pass": npu["sidekick"]["pass"],
            "pass": comparison_pass,
        },
    }
    summary_path = result_dir / f"real-text-summary-{args.sequence_length}.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"COMPARISON_PASS={str(comparison_pass).lower()}")
    print(f"SUMMARY={summary_path}")
    return 0 if comparison_pass else 2


if __name__ == "__main__":
    raise SystemExit(main())
