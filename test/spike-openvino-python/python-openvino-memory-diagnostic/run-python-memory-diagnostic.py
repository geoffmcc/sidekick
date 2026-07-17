#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import threading
from pathlib import Path


def pump(stream, sink, capture):
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


def run_child(python_exe: Path, child_script: Path, args, timeout_seconds: int):
    creationflags = 0
    popen_kwargs = {}
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(
        [str(python_exe), str(child_script), *map(str, args)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        creationflags=creationflags,
        **popen_kwargs,
    )

    out_lines, err_lines = [], []
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
        "stdout": "".join(out_lines)[-65536:],
        "stderr": "".join(err_lines)[-65536:],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("sequence_length", type=int, nargs="?", default=512)
    parser.add_argument("warmups", type=int, nargs="?", default=5)
    parser.add_argument("iterations", type=int, nargs="?", default=50)
    parser.add_argument("gc_every", type=int, nargs="?", default=1)
    parser.add_argument("timeout_ms", type=int, nargs="?", default=900000)
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    python_exe = Path(sys.executable).resolve()
    child_script = here / "python-memory-child.py"
    result_dir = here / "probe-results"
    result_dir.mkdir(exist_ok=True)

    print(f"Python: {sys.version.split()[0]} ({'x64' if sys.maxsize > 2**32 else 'x86'})")
    print(f"Model: {Path(args.model_dir).resolve()}")
    print(f"Static profile: [1,{args.sequence_length}]")
    print(f"Warmups: {args.warmups}; iterations: {args.iterations}; forced GC every {args.gc_every}")
    print(f"Per-child hard timeout: {args.timeout_ms} ms")

    summary = {
        "python": sys.version,
        "python_executable": str(python_exe),
        "model_dir": str(Path(args.model_dir).resolve()),
        "sequence_length": args.sequence_length,
        "warmups": args.warmups,
        "iterations": args.iterations,
        "gc_every": args.gc_every,
        "timeout_ms": args.timeout_ms,
        "devices": {},
    }

    for device in ("CPU", "NPU"):
        print(f"\n=== {device} ===", flush=True)
        result = run_child(
            python_exe,
            child_script,
            [
                Path(args.model_dir).resolve(),
                device,
                args.sequence_length,
                args.warmups,
                args.iterations,
                args.gc_every,
                result_dir,
            ],
            max(1, args.timeout_ms // 1000),
        )
        status = "timeout" if result["timed_out"] else ("pass" if result["code"] == 0 else "fail")
        print(f"{device}_STATUS={status} CODE={result['code']}", flush=True)
        summary["devices"][device] = {
            "status": status,
            "code": result["code"],
            "timed_out": result["timed_out"],
            "stderr_tail": result["stderr"],
        }

    summary_path = result_dir / f"python-memory-summary-{args.sequence_length}.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nSUMMARY={summary_path}")
    return 0 if all(x["status"] == "pass" for x in summary["devices"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
