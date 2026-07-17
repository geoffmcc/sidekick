#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np


THRESHOLD = 0.999
OFFICIAL_EXPECTED = [0, 1]
SIDEKICK_EXPECTED = [0, 1, 2, 3]


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator <= 0.0 or not math.isfinite(denominator):
        raise RuntimeError("Invalid embedding norm")
    return float(np.dot(a, b) / denominator)


def load_result(result_dir: Path, device: str, profile: int) -> dict[str, Any]:
    path = result_dir / f"real-text-{device.lower()}-{profile}.json"
    if not path.is_file():
        raise FileNotFoundError(f"Missing result file: {path}")
    result = json.loads(path.read_text(encoding="utf-8"))
    result["_path"] = str(path)
    return result


def compare_texts(left: dict[str, Any], right: dict[str, Any]) -> None:
    left_records = left["records"]
    right_records = right["records"]
    if len(left_records) != len(right_records):
        raise RuntimeError(
            f"Record-count mismatch: {len(left_records)} vs {len(right_records)}"
        )

    for index, (a, b) in enumerate(zip(left_records, right_records)):
        if a["text"] != b["text"]:
            raise RuntimeError(f"Text mismatch at index {index}")
        if a["token_count"] != b["token_count"]:
            raise RuntimeError(
                f"Token-count mismatch at index {index}: "
                f"{a['token_count']} vs {b['token_count']}"
            )


def embedding_array(result: dict[str, Any]) -> np.ndarray:
    array = np.asarray(result["embeddings"], dtype=np.float32)
    if array.ndim != 2:
        raise RuntimeError(f"Unexpected embedding array shape: {array.shape}")
    return array


def pairwise_same_text(
    name: str,
    left: np.ndarray,
    right: np.ndarray,
) -> dict[str, Any]:
    if left.shape != right.shape:
        raise RuntimeError(f"{name} shape mismatch: {left.shape} vs {right.shape}")

    cosines = [cosine(left[i], right[i]) for i in range(left.shape[0])]
    result = {
        "name": name,
        "per_text_cosines": cosines,
        "minimum": min(cosines),
        "mean": float(np.mean(cosines)),
        "maximum": max(cosines),
        "threshold": THRESHOLD,
        "pass": min(cosines) >= THRESHOLD,
    }

    print(f"{name}_PER_TEXT_COSINES={json.dumps(cosines)}")
    print(f"{name}_MIN_COSINE={result['minimum']:.12f}")
    print(f"{name}_MEAN_COSINE={result['mean']:.12f}")
    print(f"{name}_PASS={str(result['pass']).lower()}")
    return result


def ranking_case(
    name: str,
    query_embeddings: np.ndarray,
    document_embeddings: np.ndarray,
) -> dict[str, Any]:
    official_queries = query_embeddings[0:2]
    official_documents = document_embeddings[2:4]
    sidekick_queries = query_embeddings[4:8]
    sidekick_documents = document_embeddings[8:16]

    official_scores = official_queries @ official_documents.T
    sidekick_scores = sidekick_queries @ sidekick_documents.T

    official_top = np.argmax(official_scores, axis=1).tolist()
    sidekick_top = np.argmax(sidekick_scores, axis=1).tolist()

    official_pass = official_top == OFFICIAL_EXPECTED
    sidekick_pass = sidekick_top == SIDEKICK_EXPECTED
    passed = official_pass and sidekick_pass

    result = {
        "name": name,
        "official_scores": official_scores.tolist(),
        "official_top_docs": official_top,
        "official_expected_docs": OFFICIAL_EXPECTED,
        "official_pass": official_pass,
        "sidekick_scores": sidekick_scores.tolist(),
        "sidekick_top_docs": sidekick_top,
        "sidekick_expected_docs": SIDEKICK_EXPECTED,
        "sidekick_pass": sidekick_pass,
        "pass": passed,
    }

    print(f"{name}_OFFICIAL_TOP_DOCS={json.dumps(official_top)}")
    print(f"{name}_SIDEKICK_TOP_DOCS={json.dumps(sidekick_top)}")
    print(f"{name}_RANKING_PASS={str(passed).lower()}")
    return result


def main() -> int:
    here = Path(__file__).resolve().parent
    result_dir = here.parent / "qwen-real-text-correctness" / "probe-results"

    results = {
        ("CPU", 128): load_result(result_dir, "CPU", 128),
        ("CPU", 512): load_result(result_dir, "CPU", 512),
        ("NPU", 128): load_result(result_dir, "NPU", 128),
        ("NPU", 512): load_result(result_dir, "NPU", 512),
    }

    reference = results[("CPU", 128)]
    for result in results.values():
        compare_texts(reference, result)

    arrays = {
        key: embedding_array(value)
        for key, value in results.items()
    }

    compatibility = [
        pairwise_same_text(
            "CPU_128_VS_CPU_512",
            arrays[("CPU", 128)],
            arrays[("CPU", 512)],
        ),
        pairwise_same_text(
            "NPU_128_VS_NPU_512",
            arrays[("NPU", 128)],
            arrays[("NPU", 512)],
        ),
        pairwise_same_text(
            "CPU_128_VS_NPU_512",
            arrays[("CPU", 128)],
            arrays[("NPU", 512)],
        ),
        pairwise_same_text(
            "NPU_128_VS_CPU_512",
            arrays[("NPU", 128)],
            arrays[("CPU", 512)],
        ),
    ]

    rankings = [
        ranking_case(
            "CPU_QUERY_128_DOC_512",
            arrays[("CPU", 128)],
            arrays[("CPU", 512)],
        ),
        ranking_case(
            "CPU_QUERY_512_DOC_128",
            arrays[("CPU", 512)],
            arrays[("CPU", 128)],
        ),
        ranking_case(
            "NPU_QUERY_128_DOC_512",
            arrays[("NPU", 128)],
            arrays[("NPU", 512)],
        ),
        ranking_case(
            "NPU_QUERY_512_DOC_128",
            arrays[("NPU", 512)],
            arrays[("NPU", 128)],
        ),
        ranking_case(
            "NPU_QUERY_128_CPU_DOC_512",
            arrays[("NPU", 128)],
            arrays[("CPU", 512)],
        ),
        ranking_case(
            "CPU_QUERY_128_NPU_DOC_512",
            arrays[("CPU", 128)],
            arrays[("NPU", 512)],
        ),
    ]

    compatibility_pass = all(item["pass"] for item in compatibility)
    ranking_pass = all(item["pass"] for item in rankings)
    overall_pass = compatibility_pass and ranking_pass

    report = {
        "result_directory": str(result_dir),
        "threshold": THRESHOLD,
        "sources": {
            f"{device.lower()}_{profile}": result["_path"]
            for (device, profile), result in results.items()
        },
        "text_and_token_count_parity": True,
        "same_text_compatibility": compatibility,
        "cross_profile_rankings": rankings,
        "compatibility_pass": compatibility_pass,
        "ranking_pass": ranking_pass,
        "profile_mixing_pass": overall_pass,
    }

    report_dir = here / "probe-results"
    report_dir.mkdir(exist_ok=True)
    report_path = report_dir / "qwen-profile-compatibility-128-512.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"TEXT_AND_TOKEN_COUNT_PARITY=true")
    print(f"COMPATIBILITY_PASS={str(compatibility_pass).lower()}")
    print(f"CROSS_PROFILE_RANKING_PASS={str(ranking_pass).lower()}")
    print(f"PROFILE_MIXING_PASS={str(overall_pass).lower()}")
    print(f"RESULT={report_path}")

    return 0 if overall_pass else 2


if __name__ == "__main__":
    raise SystemExit(main())
