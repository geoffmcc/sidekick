#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gc
import json
import math
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import openvino as ov
import psutil
from transformers import AutoTokenizer


TEXT = (
    "query: How can Sidekick avoid saving duplicate durable memories while "
    "preserving distinct information?"
)


def percentile(values: list[float], p: float) -> float:
    if not values:
        raise ValueError("No values")
    ordered = sorted(values)
    index = (len(ordered) - 1) * p
    lower = int(math.floor(index))
    upper = int(math.ceil(index))
    if lower == upper:
        return ordered[lower]
    fraction = index - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def mb(value: int) -> float:
    return value / (1024 * 1024)


def model_input_names(model: ov.Model) -> list[str]:
    names: list[str] = []
    for index, port in enumerate(model.inputs):
        try:
            names.append(port.get_any_name())
        except Exception:
            names.append(f"input_{index}")
    return names


def choose_hidden_state(outputs) -> np.ndarray:
    candidates = []
    for value in outputs.values():
        array = np.asarray(value)
        if array.ndim == 3:
            candidates.append(array)
    if len(candidates) != 1:
        shapes = [list(np.asarray(value).shape) for value in outputs.values()]
        raise RuntimeError(
            f"Expected one rank-3 hidden-state output, observed: {shapes}"
        )
    return np.asarray(candidates[0], dtype=np.float32)


def average_pool(hidden: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    mask = np.asarray(attention_mask, dtype=np.float32)[..., None]
    summed = (hidden * mask).sum(axis=1)
    counts = mask.sum(axis=1)
    if np.any(counts <= 0):
        raise RuntimeError("Empty attention mask")
    vector = (summed / counts)[0]
    norm = float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError(f"Invalid norm: {norm}")
    return vector / norm


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("device", choices=["CPU", "NPU"], nargs="?", default="CPU")
    parser.add_argument("sequence_length", type=int, nargs="?", default=512)
    parser.add_argument("warmups", type=int, nargs="?", default=20)
    parser.add_argument("iterations", type=int, nargs="?", default=1000)
    parser.add_argument("checkpoint_every", type=int, nargs="?", default=100)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    xml = model_dir / "openvino_model.xml"
    if not xml.is_file():
        raise FileNotFoundError(f"Missing model XML: {xml}")

    process = psutil.Process()
    print(f"PYTHON={sys.version.replace(chr(10), ' ')}", flush=True)
    print(f"OPENVINO={ov.__version__}", flush=True)
    print(f"TARGET={args.device}", flush=True)
    print(f"MODEL={model_dir}", flush=True)
    print(f"STATIC_PROFILE=[1,{args.sequence_length}]", flush=True)
    print(f"WARMUPS={args.warmups}", flush=True)
    print(f"ITERATIONS={args.iterations}", flush=True)

    tokenizer = AutoTokenizer.from_pretrained(
        str(model_dir),
        local_files_only=True,
        trust_remote_code=False,
        use_fast=True,
    )

    token_times: list[float] = []
    encoded = None
    for _ in range(args.warmups):
        tokenizer(
            TEXT,
            padding="max_length",
            truncation=True,
            max_length=args.sequence_length,
            return_attention_mask=True,
            return_tensors="np",
        )

    for _ in range(args.iterations):
        started = time.perf_counter()
        encoded = tokenizer(
            TEXT,
            padding="max_length",
            truncation=True,
            max_length=args.sequence_length,
            return_attention_mask=True,
            return_tensors="np",
        )
        token_times.append((time.perf_counter() - started) * 1000)

    if encoded is None:
        raise RuntimeError("Tokenizer produced no output")

    tokens = {
        key: np.asarray(value, dtype=np.int64)
        for key, value in encoded.items()
    }

    core = ov.Core()
    load_started = time.perf_counter()
    model = core.read_model(str(xml))
    load_ms = (time.perf_counter() - load_started) * 1000

    input_names = model_input_names(model)
    reshape_map = {}
    for port in model.inputs:
        name = port.get_any_name()
        if name in {"input_ids", "attention_mask", "token_type_ids"}:
            reshape_map[port] = [1, args.sequence_length]
    model.reshape(reshape_map)

    compile_started = time.perf_counter()
    compiled = core.compile_model(model, args.device)
    compile_ms = (time.perf_counter() - compile_started) * 1000
    request = compiled.create_infer_request()

    infer_inputs = {}
    for name in input_names:
        if name in tokens:
            infer_inputs[name] = tokens[name]
        elif name == "token_type_ids":
            infer_inputs[name] = np.zeros(
                (1, args.sequence_length), dtype=np.int64
            )
        else:
            raise RuntimeError(f"No input value for {name}")

    first_started = time.perf_counter()
    first_outputs = request.infer(
        infer_inputs, share_inputs=False, share_outputs=False
    )
    first_infer_ms = (time.perf_counter() - first_started) * 1000
    first_vector = average_pool(
        choose_hidden_state(first_outputs), tokens["attention_mask"]
    )

    for _ in range(max(args.warmups - 1, 0)):
        outputs = request.infer(
            infer_inputs, share_inputs=False, share_outputs=False
        )
        average_pool(choose_hidden_state(outputs), tokens["attention_mask"])

    gc.collect()
    time.sleep(0.1)
    baseline = process.memory_info()
    print(f"BASELINE_RSS_MB={mb(baseline.rss):.2f}", flush=True)
    print(f"BASELINE_VMS_MB={mb(baseline.vms):.2f}", flush=True)

    infer_times: list[float] = []
    end_to_end_times: list[float] = []
    final_vector = first_vector

    for index in range(1, args.iterations + 1):
        e2e_started = time.perf_counter()

        tokenize_started = time.perf_counter()
        current = tokenizer(
            TEXT,
            padding="max_length",
            truncation=True,
            max_length=args.sequence_length,
            return_attention_mask=True,
            return_tensors="np",
        )
        tokenize_elapsed = (time.perf_counter() - tokenize_started) * 1000

        current_tokens = {
            key: np.asarray(value, dtype=np.int64)
            for key, value in current.items()
        }
        current_inputs = {}
        for name in input_names:
            if name in current_tokens:
                current_inputs[name] = current_tokens[name]
            elif name == "token_type_ids":
                current_inputs[name] = np.zeros(
                    (1, args.sequence_length), dtype=np.int64
                )

        infer_started = time.perf_counter()
        outputs = request.infer(
            current_inputs, share_inputs=False, share_outputs=False
        )
        infer_elapsed = (time.perf_counter() - infer_started) * 1000
        final_vector = average_pool(
            choose_hidden_state(outputs), current_tokens["attention_mask"]
        )
        e2e_elapsed = (time.perf_counter() - e2e_started) * 1000

        token_times.append(tokenize_elapsed)
        infer_times.append(infer_elapsed)
        end_to_end_times.append(e2e_elapsed)

        if index % args.checkpoint_every == 0 or index == args.iterations:
            gc.collect()
            mem = process.memory_info()
            print(
                f"CHECKPOINT_{index}_RSS_MB={mb(mem.rss):.2f}",
                flush=True,
            )
            print(
                f"CHECKPOINT_{index}_VMS_MB={mb(mem.vms):.2f}",
                flush=True,
            )

    gc.collect()
    time.sleep(0.2)
    final = process.memory_info()

    repeat_cosine = float(np.dot(first_vector, final_vector))
    result = {
        "device": args.device,
        "model_dir": str(model_dir),
        "sequence_length": args.sequence_length,
        "warmups": args.warmups,
        "iterations": args.iterations,
        "load_ms": load_ms,
        "compile_ms": compile_ms,
        "first_infer_ms": first_infer_ms,
        "tokenizer": {
            "median_ms": statistics.median(token_times),
            "p95_ms": percentile(token_times, 0.95),
            "p99_ms": percentile(token_times, 0.99),
            "mean_ms": statistics.fmean(token_times),
        },
        "inference": {
            "median_ms": statistics.median(infer_times),
            "p95_ms": percentile(infer_times, 0.95),
            "p99_ms": percentile(infer_times, 0.99),
            "mean_ms": statistics.fmean(infer_times),
            "throughput_per_sec": 1000 / statistics.fmean(infer_times),
        },
        "end_to_end": {
            "median_ms": statistics.median(end_to_end_times),
            "p95_ms": percentile(end_to_end_times, 0.95),
            "p99_ms": percentile(end_to_end_times, 0.99),
            "mean_ms": statistics.fmean(end_to_end_times),
            "throughput_per_sec": 1000 / statistics.fmean(end_to_end_times),
        },
        "memory": {
            "baseline_rss_mb": mb(baseline.rss),
            "final_rss_mb": mb(final.rss),
            "growth_rss_mb": mb(final.rss - baseline.rss),
            "baseline_vms_mb": mb(baseline.vms),
            "final_vms_mb": mb(final.vms),
            "growth_vms_mb": mb(final.vms - baseline.vms),
        },
        "repeat_cosine": repeat_cosine,
        "embedding_dim": int(final_vector.shape[0]),
    }

    result_dir = Path(__file__).resolve().parent / "probe-results"
    result_dir.mkdir(exist_ok=True)
    result_path = (
        result_dir
        / f"e5-sustained-{args.device.lower()}-{args.sequence_length}.json"
    )
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(f"LOAD_MS={load_ms:.3f}", flush=True)
    print(f"COMPILE_MS={compile_ms:.3f}", flush=True)
    print(f"FIRST_INFER_MS={first_infer_ms:.3f}", flush=True)
    print(
        f"TOKENIZER_MEDIAN_MS={result['tokenizer']['median_ms']:.3f}",
        flush=True,
    )
    print(
        f"TOKENIZER_P95_MS={result['tokenizer']['p95_ms']:.3f}",
        flush=True,
    )
    print(
        f"INFER_MEDIAN_MS={result['inference']['median_ms']:.3f}",
        flush=True,
    )
    print(
        f"INFER_P95_MS={result['inference']['p95_ms']:.3f}",
        flush=True,
    )
    print(
        f"INFER_P99_MS={result['inference']['p99_ms']:.3f}",
        flush=True,
    )
    print(
        f"INFER_THROUGHPUT_PER_SEC="
        f"{result['inference']['throughput_per_sec']:.3f}",
        flush=True,
    )
    print(
        f"END_TO_END_MEDIAN_MS={result['end_to_end']['median_ms']:.3f}",
        flush=True,
    )
    print(
        f"END_TO_END_P95_MS={result['end_to_end']['p95_ms']:.3f}",
        flush=True,
    )
    print(
        f"END_TO_END_THROUGHPUT_PER_SEC="
        f"{result['end_to_end']['throughput_per_sec']:.3f}",
        flush=True,
    )
    print(f"FINAL_RSS_MB={mb(final.rss):.2f}", flush=True)
    print(
        f"GROWTH_RSS_MB={mb(final.rss - baseline.rss):.2f}",
        flush=True,
    )
    print(
        f"GROWTH_VMS_MB={mb(final.vms - baseline.vms):.2f}",
        flush=True,
    )
    print(f"EMBEDDING_DIM={final_vector.shape[0]}", flush=True)
    print(f"REPEAT_COSINE={repeat_cosine:.12f}", flush=True)
    print(f"RESULT={result_path}", flush=True)
    print("PASS", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(
            f"ERROR={type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        raise
