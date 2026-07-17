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


TASK = (
    "Given a user query, retrieve the most relevant passage that answers "
    "the query or contains the needed technical information"
)

QUERY = (
    "How can Sidekick avoid saving duplicate durable memories while "
    "preserving distinct information?"
)

TEXT = f"Instruct: {TASK}\nQuery:{QUERY}"


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("No values")
    index = (len(ordered) - 1) * p
    lower = int(math.floor(index))
    upper = int(math.ceil(index))
    if lower == upper:
        return ordered[lower]
    fraction = index - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def mb(value: int) -> float:
    return value / (1024 * 1024)


def l2_normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError(f"Invalid norm: {norm}")
    return vector / norm


def pool_last_token(hidden: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    hidden = np.asarray(hidden, dtype=np.float32)
    if hidden.ndim != 3 or hidden.shape[0] != 1:
        raise RuntimeError(f"Unexpected hidden-state shape: {hidden.shape}")

    if bool(np.all(attention_mask[:, -1] == 1)):
        pooled = hidden[:, -1, :]
    else:
        sequence_lengths = attention_mask.sum(axis=1) - 1
        pooled = hidden[np.arange(hidden.shape[0]), sequence_lengths]

    return l2_normalize(pooled[0])


def input_names(model: ov.Model) -> list[str]:
    result = []
    for index, port in enumerate(model.inputs):
        try:
            result.append(port.get_any_name())
        except Exception:
            result.append(f"input_{index}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("device", choices=["CPU", "NPU"], nargs="?", default="NPU")
    parser.add_argument("sequence_length", type=int, nargs="?", default=512)
    parser.add_argument("warmups", type=int, nargs="?", default=20)
    parser.add_argument("iterations", type=int, nargs="?", default=500)
    parser.add_argument("checkpoint_every", type=int, nargs="?", default=50)
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
        padding_side="left",
        fix_mistral_regex=True,
    )
    tokenizer.padding_side = "left"

    for _ in range(args.warmups):
        tokenizer(
            TEXT,
            padding="max_length",
            truncation=True,
            max_length=args.sequence_length,
            return_attention_mask=True,
            return_tensors="np",
        )

    core = ov.Core()
    print(f"DEVICES={','.join(core.available_devices)}", flush=True)

    load_started = time.perf_counter()
    model = core.read_model(str(xml))
    load_ms = (time.perf_counter() - load_started) * 1000

    names = input_names(model)
    if "input_ids" not in names or "attention_mask" not in names:
        raise RuntimeError(f"Required inputs missing: {names}")

    reshape_map = {}
    for port in model.inputs:
        name = port.get_any_name()
        if name in {"input_ids", "attention_mask"}:
            reshape_map[port] = [1, args.sequence_length]
    model.reshape(reshape_map)

    compile_started = time.perf_counter()
    compiled = core.compile_model(model, args.device)
    compile_ms = (time.perf_counter() - compile_started) * 1000
    request = compiled.create_infer_request()

    encoded = tokenizer(
        TEXT,
        padding="max_length",
        truncation=True,
        max_length=args.sequence_length,
        return_attention_mask=True,
        return_tensors="np",
    )
    fixed_tokens = {
        key: np.asarray(value, dtype=np.int64)
        for key, value in encoded.items()
    }

    first_started = time.perf_counter()
    first_outputs = request.infer(
        {
            "input_ids": fixed_tokens["input_ids"],
            "attention_mask": fixed_tokens["attention_mask"],
        },
        share_inputs=False,
        share_outputs=False,
    )
    first_infer_ms = (time.perf_counter() - first_started) * 1000
    first_hidden = np.asarray(next(iter(first_outputs.values())), dtype=np.float32)
    first_vector = pool_last_token(first_hidden, fixed_tokens["attention_mask"])

    for _ in range(max(args.warmups - 1, 0)):
        outputs = request.infer(
            {
                "input_ids": fixed_tokens["input_ids"],
                "attention_mask": fixed_tokens["attention_mask"],
            },
            share_inputs=False,
            share_outputs=False,
        )
        hidden = np.asarray(next(iter(outputs.values())), dtype=np.float32)
        pool_last_token(hidden, fixed_tokens["attention_mask"])

    gc.collect()
    time.sleep(0.1)
    baseline = process.memory_info()
    print(f"BASELINE_RSS_MB={mb(baseline.rss):.2f}", flush=True)
    print(f"BASELINE_VMS_MB={mb(baseline.vms):.2f}", flush=True)

    token_times = []
    infer_times = []
    end_to_end_times = []
    final_vector = first_vector

    for index in range(1, args.iterations + 1):
        e2e_started = time.perf_counter()

        token_started = time.perf_counter()
        current = tokenizer(
            TEXT,
            padding="max_length",
            truncation=True,
            max_length=args.sequence_length,
            return_attention_mask=True,
            return_tensors="np",
        )
        token_times.append((time.perf_counter() - token_started) * 1000)

        current_tokens = {
            key: np.asarray(value, dtype=np.int64)
            for key, value in current.items()
        }

        infer_started = time.perf_counter()
        outputs = request.infer(
            {
                "input_ids": current_tokens["input_ids"],
                "attention_mask": current_tokens["attention_mask"],
            },
            share_inputs=False,
            share_outputs=False,
        )
        infer_times.append((time.perf_counter() - infer_started) * 1000)

        hidden = np.asarray(next(iter(outputs.values())), dtype=np.float32)
        final_vector = pool_last_token(hidden, current_tokens["attention_mask"])
        end_to_end_times.append((time.perf_counter() - e2e_started) * 1000)

        if index % args.checkpoint_every == 0 or index == args.iterations:
            gc.collect()
            mem = process.memory_info()
            print(f"CHECKPOINT_{index}_RSS_MB={mb(mem.rss):.2f}", flush=True)
            print(f"CHECKPOINT_{index}_VMS_MB={mb(mem.vms):.2f}", flush=True)

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
        / f"qwen-sustained-{args.device.lower()}-{args.sequence_length}.json"
    )
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(f"LOAD_MS={load_ms:.3f}", flush=True)
    print(f"COMPILE_MS={compile_ms:.3f}", flush=True)
    print(f"FIRST_INFER_MS={first_infer_ms:.3f}", flush=True)
    print(f"TOKENIZER_MEDIAN_MS={result['tokenizer']['median_ms']:.3f}", flush=True)
    print(f"TOKENIZER_P95_MS={result['tokenizer']['p95_ms']:.3f}", flush=True)
    print(f"INFER_MEDIAN_MS={result['inference']['median_ms']:.3f}", flush=True)
    print(f"INFER_P95_MS={result['inference']['p95_ms']:.3f}", flush=True)
    print(f"INFER_P99_MS={result['inference']['p99_ms']:.3f}", flush=True)
    print(
        f"INFER_THROUGHPUT_PER_SEC={result['inference']['throughput_per_sec']:.3f}",
        flush=True,
    )
    print(
        f"END_TO_END_MEDIAN_MS={result['end_to_end']['median_ms']:.3f}",
        flush=True,
    )
    print(f"END_TO_END_P95_MS={result['end_to_end']['p95_ms']:.3f}", flush=True)
    print(
        f"END_TO_END_THROUGHPUT_PER_SEC="
        f"{result['end_to_end']['throughput_per_sec']:.3f}",
        flush=True,
    )
    print(f"FINAL_RSS_MB={mb(final.rss):.2f}", flush=True)
    print(f"GROWTH_RSS_MB={mb(final.rss - baseline.rss):.2f}", flush=True)
    print(f"GROWTH_VMS_MB={mb(final.vms - baseline.vms):.2f}", flush=True)
    print(f"EMBEDDING_DIM={final_vector.shape[0]}", flush=True)
    print(f"REPEAT_COSINE={repeat_cosine:.12f}", flush=True)
    print(f"RESULT={result_path}", flush=True)
    print("PASS", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR={type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise
