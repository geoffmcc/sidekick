#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import openvino as ov
from transformers import AutoTokenizer

OFFICIAL_QUERIES = [
    "how much protein should a female eat",
    "summit define",
]

OFFICIAL_DOCUMENTS = [
    (
        "As a general guideline, the CDC's average requirement of protein for "
        "women ages 19 to 70 is 46 grams per day."
    ),
    (
        "Definition of summit for English Language Learners: the highest point "
        "of a mountain, the highest level, or a meeting between leaders."
    ),
]

SIDEKICK_QUERIES = [
    "How do I configure VLAN routing in OpenWrt?",
    "How can Sidekick avoid saving duplicate memories?",
    "Why should OpenVINO inference run in a supervised helper process?",
    "Why do Samba shares sometimes reconnect with a password error?",
]

SIDEKICK_DOCUMENTS = [
    (
        "Configure inter-VLAN routing on OpenWrt by creating VLAN interfaces, "
        "assigning firewall zones, and adding only the required forwarding rules."
    ),
    (
        "Sidekick can compare a proposed memory embedding with existing vectors "
        "and reject or merge high-similarity near duplicates."
    ),
    (
        "A supervised OpenVINO helper isolates native runtime failures from the "
        "main worker and lets the parent terminate a hung inference process."
    ),
    (
        "Windows SMB reconnect failures may come from stale sessions or cached "
        "credentials even when the saved Samba password is correct."
    ),
    "Chocolate cake is commonly covered with buttercream frosting.",
    "The capital of France is Paris.",
    "A graphics card renders images and can accelerate large language models.",
    "A teapot was found in the woods during a historical family disappearance.",
]

SIDEKICK_EXPECTED_DOCS = [0, 1, 2, 3]


def metric(name: str, value: Any) -> None:
    print(f"{name}={value}", flush=True)


def l2_normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError(f"Invalid embedding norm: {norm}")
    return vector / norm


def average_pool(hidden: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    hidden = np.asarray(hidden, dtype=np.float32)
    mask = np.asarray(attention_mask, dtype=np.float32)[..., None]
    if hidden.ndim != 3 or hidden.shape[:2] != mask.shape[:2]:
        raise RuntimeError(
            f"Pooling shape mismatch: hidden={hidden.shape}, mask={mask.shape}"
        )
    summed = (hidden * mask).sum(axis=1)
    counts = mask.sum(axis=1)
    if np.any(counts <= 0):
        raise RuntimeError("Attention mask contains an empty sequence")
    return l2_normalize((summed / counts)[0])


def cosine_matrix(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    return np.asarray(left, dtype=np.float32) @ np.asarray(right, dtype=np.float32).T


def model_input_names(model: ov.Model) -> list[str]:
    names: list[str] = []
    for index, port in enumerate(model.inputs):
        try:
            names.append(port.get_any_name())
        except Exception:
            names.append(f"input_{index}")
    return names


def choose_hidden_state(outputs: dict[Any, Any]) -> np.ndarray:
    candidates: list[np.ndarray] = []
    for value in outputs.values():
        array = np.asarray(value)
        if array.ndim == 3:
            candidates.append(array)
    if len(candidates) != 1:
        shapes = [list(np.asarray(value).shape) for value in outputs.values()]
        raise RuntimeError(
            f"Expected exactly one rank-3 hidden-state output; observed {shapes}"
        )
    return np.asarray(candidates[0], dtype=np.float32)


def encode_text(
    tokenizer,
    text: str,
    is_query: bool,
    sequence_length: int,
) -> dict[str, np.ndarray]:
    prefixed = f"{'query' if is_query else 'passage'}: {text}"
    encoded = tokenizer(
        prefixed,
        padding="max_length",
        truncation=True,
        max_length=sequence_length,
        return_attention_mask=True,
        return_tensors="np",
    )
    result = {}
    for key, value in encoded.items():
        result[key] = np.asarray(value, dtype=np.int64)
    if "input_ids" not in result or "attention_mask" not in result:
        raise RuntimeError(f"Tokenizer returned incomplete keys: {list(result)}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("device", choices=["CPU", "NPU"])
    parser.add_argument("sequence_length", type=int, nargs="?", default=512)
    parser.add_argument("result_dir", nargs="?", default="probe-results")
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    xml = model_dir / "openvino_model.xml"
    result_dir = Path(args.result_dir).resolve()
    result_dir.mkdir(parents=True, exist_ok=True)
    result_path = result_dir / f"e5-real-text-{args.device.lower()}-{args.sequence_length}.json"

    if not xml.is_file():
        raise FileNotFoundError(f"Missing OpenVINO model: {xml}")

    metric("TARGET", args.device)
    metric("PYTHON", sys.version.replace("\n", " "))
    metric("OPENVINO", ov.__version__)
    metric("MODEL", str(model_dir))
    metric("SEQUENCE_LENGTH", args.sequence_length)

    tokenizer = AutoTokenizer.from_pretrained(
        str(model_dir),
        local_files_only=True,
        trust_remote_code=False,
        use_fast=True,
    )
    metric("TOKENIZER_CLASS", tokenizer.__class__.__name__)
    metric("TOKENIZER_FAST", bool(getattr(tokenizer, "is_fast", False)))
    metric("TOKENIZER_PADDING_SIDE", tokenizer.padding_side)

    core = ov.Core()
    metric("DEVICES", ",".join(core.available_devices))

    load_start = time.perf_counter()
    model = core.read_model(str(xml))
    load_ms = (time.perf_counter() - load_start) * 1000
    input_names = model_input_names(model)
    metric("MODEL_INPUT_NAMES", json.dumps(input_names))
    metric("MODEL_OUTPUTS", len(model.outputs))

    reshape_map = {}
    for port in model.inputs:
        name = port.get_any_name()
        if name in {"input_ids", "attention_mask", "token_type_ids"}:
            reshape_map[port] = [1, args.sequence_length]
    if "input_ids" not in input_names or "attention_mask" not in input_names:
        raise RuntimeError(f"Required inputs missing: {input_names}")
    model.reshape(reshape_map)

    compile_start = time.perf_counter()
    compiled = core.compile_model(model, args.device)
    compile_ms = (time.perf_counter() - compile_start) * 1000
    request = compiled.create_infer_request()

    texts: list[tuple[str, bool]] = (
        [(text, True) for text in OFFICIAL_QUERIES]
        + [(text, False) for text in OFFICIAL_DOCUMENTS]
        + [(text, True) for text in SIDEKICK_QUERIES]
        + [(text, False) for text in SIDEKICK_DOCUMENTS]
    )

    embeddings: list[np.ndarray] = []
    records: list[dict[str, Any]] = []

    for index, (text, is_query) in enumerate(texts):
        tokens = encode_text(tokenizer, text, is_query, args.sequence_length)
        infer_inputs = {}
        for name in input_names:
            if name in tokens:
                infer_inputs[name] = tokens[name]
            elif name == "token_type_ids":
                infer_inputs[name] = np.zeros((1, args.sequence_length), dtype=np.int64)
            else:
                raise RuntimeError(f"No tokenizer value for model input {name}")

        started = time.perf_counter()
        outputs = request.infer(infer_inputs, share_inputs=False, share_outputs=False)
        infer_ms = (time.perf_counter() - started) * 1000
        hidden = choose_hidden_state(outputs)
        embedding = average_pool(hidden, tokens["attention_mask"])

        if not np.all(np.isfinite(embedding)):
            raise RuntimeError(f"Non-finite embedding for text {index}")

        embeddings.append(embedding)
        records.append(
            {
                "index": index,
                "is_query": is_query,
                "text": text,
                "token_count": int(tokens["attention_mask"].sum()),
                "input_ids_first_16": tokens["input_ids"][0, :16].tolist(),
                "input_ids_last_16": tokens["input_ids"][0, -16:].tolist(),
                "attention_mask_first_16": tokens["attention_mask"][0, :16].tolist(),
                "attention_mask_last_16": tokens["attention_mask"][0, -16:].tolist(),
                "infer_ms": infer_ms,
                "embedding_norm": float(np.linalg.norm(embedding)),
                "embedding_first_8": embedding[:8].tolist(),
            }
        )
        metric(
            f"TEXT_{index}",
            json.dumps(
                {
                    "tokens": records[-1]["token_count"],
                    "infer_ms": round(infer_ms, 3),
                    "norm": round(records[-1]["embedding_norm"], 9),
                },
                separators=(",", ":"),
            ),
        )

    matrix = np.stack(embeddings)
    official_q = matrix[:2]
    official_d = matrix[2:4]
    sidekick_q = matrix[4:8]
    sidekick_d = matrix[8:]

    official_scores = cosine_matrix(official_q, official_d)
    sidekick_scores = cosine_matrix(sidekick_q, sidekick_d)
    official_top = np.argmax(official_scores, axis=1).tolist()
    sidekick_top = np.argmax(sidekick_scores, axis=1).tolist()

    official_pass = official_top == [0, 1]
    sidekick_pass = sidekick_top == SIDEKICK_EXPECTED_DOCS

    metric("OFFICIAL_SCORE_MATRIX", json.dumps(official_scores.tolist()))
    metric("OFFICIAL_TOP_DOCS", json.dumps(official_top))
    metric("OFFICIAL_RANKING_PASS", str(official_pass).lower())
    metric("SIDEKICK_SCORE_MATRIX", json.dumps(sidekick_scores.tolist()))
    metric("SIDEKICK_TOP_DOCS", json.dumps(sidekick_top))
    metric("SIDEKICK_RANKING_PASS", str(sidekick_pass).lower())

    result = {
        "device": args.device,
        "python": sys.version,
        "openvino": ov.__version__,
        "model_dir": str(model_dir),
        "sequence_length": args.sequence_length,
        "load_ms": load_ms,
        "compile_ms": compile_ms,
        "input_names": input_names,
        "records": records,
        "embeddings": matrix.tolist(),
        "official": {
            "queries": OFFICIAL_QUERIES,
            "documents": OFFICIAL_DOCUMENTS,
            "scores": official_scores.tolist(),
            "top_docs": official_top,
            "expected_docs": [0, 1],
            "pass": official_pass,
        },
        "sidekick": {
            "queries": SIDEKICK_QUERIES,
            "documents": SIDEKICK_DOCUMENTS,
            "scores": sidekick_scores.tolist(),
            "top_docs": sidekick_top,
            "expected_docs": SIDEKICK_EXPECTED_DOCS,
            "pass": sidekick_pass,
        },
    }
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    metric("LOAD_MS", f"{load_ms:.3f}")
    metric("COMPILE_MS", f"{compile_ms:.3f}")
    metric("RESULT", str(result_path))
    print("PASS", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR={type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise
