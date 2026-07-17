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


def run_child(python_exe: Path, child: Path, args: list[Any], timeout_seconds: int):
    kwargs: dict[str, Any] = {}
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(
        [str(python_exe), str(child), *map(str, args)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        creationflags=creationflags,
        **kwargs,
    )
    out_lines: list[str] = []
    err_lines: list[str] = []
    t_out = threading.Thread(target=pump, args=(proc.stdout, sys.stdout, out_lines), daemon=True)
    t_err = threading.Thread(target=pump, args=(proc.stderr, sys.stderr, err_lines), daemon=True)
    t_out.start()
    t_err.start()

    timed_out = False
    try:
        code = proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_tree(proc.pid)
        code = proc.wait(timeout=30)

    t_out.join(timeout=2)
    t_err.join(timeout=2)
    return {
        "code": code,
        "timed_out": timed_out,
        "stdout_tail": "".join(out_lines)[-65536:],
        "stderr_tail": "".join(err_lines)[-65536:],
    }


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 0 or not math.isfinite(denom):
        raise RuntimeError("Invalid vector norm")
    return float(np.dot(a, b) / denom)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("sequence_length", type=int, nargs="?", default=512)
    parser.add_argument("timeout_ms", type=int, nargs="?", default=900000)
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    child = here / "e5-real-text-child.py"
    result_dir = here / "probe-results"
    result_dir.mkdir(exist_ok=True)
    python_exe = Path(sys.executable).resolve()

    print(f"Python: {sys.version.split()[0]}")
    print(f"Model: {Path(args.model_dir).resolve()}")
    print(f"Static profile: [1,{args.sequence_length}]")
    print(f"Per-child hard timeout: {args.timeout_ms} ms")

    statuses = {}
    for device in ("CPU", "NPU"):
        print(f"\n=== {device} ===", flush=True)
        result = run_child(
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
        status = "timeout" if result["timed_out"] else ("pass" if result["code"] == 0 else "fail")
        print(f"{device}_STATUS={status} CODE={result['code']}", flush=True)
        statuses[device] = {"status": status, **result}

    summary_path = result_dir / f"e5-real-text-summary-{args.sequence_length}.json"
    if any(item["status"] != "pass" for item in statuses.values()):
        summary_path.write_text(
            json.dumps({"statuses": statuses, "comparison": None}, indent=2),
            encoding="utf-8",
        )
        print(f"\nSUMMARY={summary_path}")
        return 1

    cpu = json.loads(
        (result_dir / f"e5-real-text-cpu-{args.sequence_length}.json").read_text(encoding="utf-8")
    )
    npu = json.loads(
        (result_dir / f"e5-real-text-npu-{args.sequence_length}.json").read_text(encoding="utf-8")
    )

    cpu_embeddings = np.asarray(cpu["embeddings"], dtype=np.float32)
    npu_embeddings = np.asarray(npu["embeddings"], dtype=np.float32)
    if cpu_embeddings.shape != npu_embeddings.shape:
        raise RuntimeError(f"Embedding shape mismatch: {cpu_embeddings.shape} vs {npu_embeddings.shape}")

    cosines = [cosine(cpu_embeddings[i], npu_embeddings[i]) for i in range(len(cpu_embeddings))]
    min_cosine = min(cosines)
    mean_cosine = float(np.mean(cosines))

    token_parity = True
    mismatches = []
    for i, (a, b) in enumerate(zip(cpu["records"], npu["records"])):
        for key in (
            "token_count",
            "input_ids_first_16",
            "input_ids_last_16",
            "attention_mask_first_16",
            "attention_mask_last_16",
        ):
            if a[key] != b[key]:
                token_parity = False
                mismatches.append(i)
                break

    official_delta = float(
        np.max(
            np.abs(
                np.asarray(cpu["official"]["scores"], dtype=np.float32)
                - np.asarray(npu["official"]["scores"], dtype=np.float32)
            )
        )
    )
    sidekick_delta = float(
        np.max(
            np.abs(
                np.asarray(cpu["sidekick"]["scores"], dtype=np.float32)
                - np.asarray(npu["sidekick"]["scores"], dtype=np.float32)
            )
        )
    )

    comparison_pass = (
        token_parity
        and min_cosine >= 0.999
        and cpu["official"]["pass"]
        and npu["official"]["pass"]
        and cpu["sidekick"]["pass"]
        and npu["sidekick"]["pass"]
    )

    print(f"\nCPU_NPU_PER_TEXT_COSINES={json.dumps(cosines)}")
    print(f"CPU_NPU_MIN_COSINE={min_cosine:.12f}")
    print(f"CPU_NPU_MEAN_COSINE={mean_cosine:.12f}")
    print(f"TOKEN_PARITY={str(token_parity).lower()}")
    print(f"TOKEN_MISMATCH_INDICES={json.dumps(mismatches)}")
    print(f"OFFICIAL_SCORE_MATRIX_MAX_DELTA={official_delta:.12f}")
    print(f"SIDEKICK_SCORE_MATRIX_MAX_DELTA={sidekick_delta:.12f}")
    print(f"CPU_OFFICIAL_RANKING_PASS={str(cpu['official']['pass']).lower()}")
    print(f"NPU_OFFICIAL_RANKING_PASS={str(npu['official']['pass']).lower()}")
    print(f"CPU_SIDEKICK_RANKING_PASS={str(cpu['sidekick']['pass']).lower()}")
    print(f"NPU_SIDEKICK_RANKING_PASS={str(npu['sidekick']['pass']).lower()}")
    print(f"COMPARISON_PASS={str(comparison_pass).lower()}")

    summary = {
        "python": sys.version,
        "model_dir": str(Path(args.model_dir).resolve()),
        "sequence_length": args.sequence_length,
        "statuses": statuses,
        "comparison": {
            "per_text_cosines": cosines,
            "min_cosine": min_cosine,
            "mean_cosine": mean_cosine,
            "token_parity": token_parity,
            "token_mismatch_indices": mismatches,
            "official_score_matrix_max_delta": official_delta,
            "sidekick_score_matrix_max_delta": sidekick_delta,
            "cpu_official_ranking_pass": cpu["official"]["pass"],
            "npu_official_ranking_pass": npu["official"]["pass"],
            "cpu_sidekick_ranking_pass": cpu["sidekick"]["pass"],
            "npu_sidekick_ranking_pass": npu["sidekick"]["pass"],
            "pass": comparison_pass,
        },
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"SUMMARY={summary_path}")
    return 0 if comparison_pass else 2


if __name__ == "__main__":
    raise SystemExit(main())
