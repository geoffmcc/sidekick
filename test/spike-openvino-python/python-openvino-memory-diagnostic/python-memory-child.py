#!/usr/bin/env python3
import argparse
import gc
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import openvino as ov
import psutil


def mb(value: int) -> float:
    return value / (1024 * 1024)


def version_dict(core: ov.Core, device: str) -> dict:
    result = {}
    try:
        versions = core.get_versions(device)
        for name, version in versions.items():
            result[name] = {
                "build_number": getattr(version, "build_number", None),
                "description": getattr(version, "description", None),
            }
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def print_metric(name: str, value) -> None:
    print(f"{name}={value}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("device", choices=["CPU", "NPU"])
    parser.add_argument("sequence_length", type=int)
    parser.add_argument("warmups", type=int)
    parser.add_argument("iterations", type=int)
    parser.add_argument("gc_every", type=int)
    parser.add_argument("result_dir")
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    model_xml = model_dir / "openvino_model.xml"
    if not model_xml.is_file():
        raise FileNotFoundError(f"Model XML not found: {model_xml}")

    result_dir = Path(args.result_dir).resolve()
    result_dir.mkdir(parents=True, exist_ok=True)
    result_path = result_dir / f"python-memory-{args.device.lower()}-{args.sequence_length}.json"

    print_metric("TARGET", args.device)
    print_metric("PYTHON", sys.version.replace("\n", " "))
    print_metric("OPENVINO", ov.__version__)

    process = psutil.Process(os.getpid())
    core = ov.Core()
    print_metric("DEVICES", ",".join(core.available_devices))
    print_metric("VERSIONS", json.dumps(version_dict(core, args.device), separators=(",", ":")))

    t0 = time.perf_counter()
    model = core.read_model(str(model_xml))
    load_ms = (time.perf_counter() - t0) * 1000

    if len(model.inputs) != 2:
        raise RuntimeError(f"Expected two model inputs, found {len(model.inputs)}")

    t0 = time.perf_counter()
    model.reshape({
        model.input(0): [1, args.sequence_length],
        model.input(1): [1, args.sequence_length],
    })
    reshape_ms = (time.perf_counter() - t0) * 1000

    for i, port in enumerate(model.inputs):
        print_metric(f"SOURCE_INPUT_{i}_PARTIAL", str(port.partial_shape))
        print_metric(f"SOURCE_INPUT_{i}_TYPE", str(port.element_type))

    t0 = time.perf_counter()
    compiled = core.compile_model(model, args.device)
    compile_ms = (time.perf_counter() - t0) * 1000

    request = compiled.create_infer_request()

    input_ids = np.ones((1, args.sequence_length), dtype=np.int64)
    attention_mask = np.ones((1, args.sequence_length), dtype=np.int64)
    request.set_input_tensor(0, ov.Tensor(input_ids))
    request.set_input_tensor(1, ov.Tensor(attention_mask))

    first_t0 = time.perf_counter()
    request.infer()
    first_infer_ms = (time.perf_counter() - first_t0) * 1000

    for _ in range(max(args.warmups - 1, 0)):
        request.infer()

    gc.collect()
    time.sleep(0.1)

    baseline = process.memory_info()
    baseline_rss = baseline.rss
    baseline_vms = baseline.vms
    print_metric("BASELINE_RSS_MB", f"{mb(baseline_rss):.2f}")
    print_metric("BASELINE_VMS_MB", f"{mb(baseline_vms):.2f}")

    latencies = []
    checksum = 0.0
    checkpoint_every = max(1, args.iterations // 5)

    for i in range(1, args.iterations + 1):
        t0 = time.perf_counter()
        request.infer()
        latencies.append((time.perf_counter() - t0) * 1000)

        output = request.get_output_tensor(0)
        data = output.data
        if data.size:
            checksum += float(data.reshape(-1)[0])

        if args.gc_every > 0 and i % args.gc_every == 0:
            del data
            del output
            gc.collect()

        if i % checkpoint_every == 0 or i == args.iterations:
            mem = process.memory_info()
            print_metric(f"CHECKPOINT_{i}_RSS_MB", f"{mb(mem.rss):.2f}")
            print_metric(f"CHECKPOINT_{i}_VMS_MB", f"{mb(mem.vms):.2f}")

    gc.collect()
    time.sleep(0.2)
    final = process.memory_info()

    output = request.get_output_tensor(0)
    output_shape = list(output.shape)
    output_type = str(output.element_type)
    output_elements = int(np.prod(output_shape))

    ordered = sorted(latencies)
    median = float(np.median(ordered))
    p95 = float(np.percentile(ordered, 95))
    mean = float(np.mean(ordered))

    result = {
        "device": args.device,
        "python": sys.version,
        "openvino": ov.__version__,
        "model_xml": str(model_xml),
        "sequence_length": args.sequence_length,
        "warmups": args.warmups,
        "iterations": args.iterations,
        "gc_every": args.gc_every,
        "load_ms": load_ms,
        "reshape_ms": reshape_ms,
        "compile_ms": compile_ms,
        "first_infer_ms": first_infer_ms,
        "warm_median_ms": median,
        "warm_p95_ms": p95,
        "warm_mean_ms": mean,
        "throughput_per_sec": 1000 / mean if mean > 0 else None,
        "baseline_rss_mb": mb(baseline_rss),
        "final_rss_mb": mb(final.rss),
        "growth_rss_mb": mb(final.rss - baseline_rss),
        "baseline_vms_mb": mb(baseline_vms),
        "final_vms_mb": mb(final.vms),
        "growth_vms_mb": mb(final.vms - baseline_vms),
        "output_shape": output_shape,
        "output_type": output_type,
        "output_elements": output_elements,
        "checksum": checksum,
        "versions": version_dict(core, args.device),
    }

    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print_metric("LOAD_MS", f"{load_ms:.3f}")
    print_metric("RESHAPE_MS", f"{reshape_ms:.3f}")
    print_metric("COMPILE_MS", f"{compile_ms:.3f}")
    print_metric("FIRST_INFER_MS", f"{first_infer_ms:.3f}")
    print_metric("WARM_MEDIAN_MS", f"{median:.3f}")
    print_metric("WARM_P95_MS", f"{p95:.3f}")
    print_metric("WARM_MEAN_MS", f"{mean:.3f}")
    print_metric("THROUGHPUT_PER_SEC", f"{result['throughput_per_sec']:.3f}")
    print_metric("FINAL_RSS_MB", f"{mb(final.rss):.2f}")
    print_metric("GROWTH_RSS_MB", f"{mb(final.rss - baseline_rss):.2f}")
    print_metric("FINAL_VMS_MB", f"{mb(final.vms):.2f}")
    print_metric("GROWTH_VMS_MB", f"{mb(final.vms - baseline_vms):.2f}")
    print_metric("OUTPUT_SHAPE", json.dumps(output_shape, separators=(",", ":")))
    print_metric("OUTPUT_TYPE", output_type)
    print_metric("CHECKSUM", f"{checksum:.9f}")
    print_metric("RESULT", str(result_path))
    print("PASS", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR={type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise
