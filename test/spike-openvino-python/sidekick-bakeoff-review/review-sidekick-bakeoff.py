#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def ndcg_at_k(ranked_ids: list[str], relevant: set[str], k: int) -> float:
    dcg = 0.0
    for rank, record_id in enumerate(ranked_ids[:k], start=1):
        if record_id in relevant:
            dcg += 1.0 / math.log2(rank + 1)

    ideal_hits = min(len(relevant), k)
    if ideal_hits == 0:
        return 0.0

    idcg = sum(1.0 / math.log2(rank + 1) for rank in range(1, ideal_hits + 1))
    return dcg / idcg


def evaluate_rankings(items: list[dict[str, Any]]) -> dict[str, float]:
    reciprocal = []
    recall_1 = []
    recall_5 = []
    recall_10 = []
    ndcg_10 = []

    for item in items:
        relevant = set(item["relevant_ids"])
        ranked = item["ranked_ids"]
        ranks = [
            rank
            for rank, record_id in enumerate(ranked, start=1)
            if record_id in relevant
        ]
        best_rank = min(ranks) if ranks else None
        reciprocal.append(0.0 if best_rank is None else 1.0 / best_rank)
        recall_1.append(float(any(x in relevant for x in ranked[:1])))
        recall_5.append(float(any(x in relevant for x in ranked[:5])))
        recall_10.append(float(any(x in relevant for x in ranked[:10])))
        ndcg_10.append(ndcg_at_k(ranked, relevant, 10))

    count = len(items)
    return {
        "query_count": count,
        "recall_at_1": sum(recall_1) / count,
        "recall_at_5": sum(recall_5) / count,
        "recall_at_10": sum(recall_10) / count,
        "mrr": sum(reciprocal) / count,
        "ndcg_at_10": sum(ndcg_10) / count,
    }


def rrf_union(
    e5_top: list[dict[str, Any]],
    qwen_top: list[dict[str, Any]],
    k: int = 60,
) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}

    for model_name, rows in (("e5", e5_top), ("qwen", qwen_top)):
        for row in rows:
            record_id = row["id"]
            entry = by_id.setdefault(
                record_id,
                {
                    "id": record_id,
                    "source": row.get("source"),
                    "heading": row.get("heading"),
                    "preview": row.get("preview"),
                    "relevant": bool(row.get("relevant")),
                    "e5_rank": None,
                    "qwen_rank": None,
                    "rrf_score": 0.0,
                },
            )
            rank = int(row["rank"])
            entry[f"{model_name}_rank"] = rank
            entry["relevant"] = entry["relevant"] or bool(row.get("relevant"))
            entry["rrf_score"] += 1.0 / (k + rank)

    return sorted(
        by_id.values(),
        key=lambda item: (
            -item["rrf_score"],
            item["e5_rank"] if item["e5_rank"] is not None else 10_000,
            item["qwen_rank"] if item["qwen_rank"] is not None else 10_000,
            item["id"],
        ),
    )


def fmt(value: float) -> str:
    return f"{value:.6f}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parent / "review-results"),
    )
    parser.add_argument("--rrf-k", type=int, default=60)
    args = parser.parse_args()

    report_path = Path(args.report).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    report = json.loads(report_path.read_text(encoding="utf-8"))
    e5 = report["results"]["e5"]
    qwen = report["results"]["qwen"]

    e5_by_id = {item["id"]: item for item in e5["per_query"]}
    qwen_by_id = {item["id"]: item for item in qwen["per_query"]}

    query_ids = sorted(set(e5_by_id) & set(qwen_by_id))
    if len(query_ids) != len(e5_by_id) or len(query_ids) != len(qwen_by_id):
        raise RuntimeError("E5 and Qwen query sets differ")

    fused_eval_items = []
    oracle_items = []
    disagreements = []

    for query_id in query_ids:
        e5_item = e5_by_id[query_id]
        qwen_item = qwen_by_id[query_id]
        relevant_ids = e5_item["relevant_ids"]

        fused = rrf_union(e5_item["top_10"], qwen_item["top_10"], args.rrf_k)
        fused_eval_items.append(
            {
                "id": query_id,
                "relevant_ids": relevant_ids,
                "ranked_ids": [row["id"] for row in fused],
            }
        )

        # Oracle is not deployable. It shows the upper bound if a perfect router
        # could always choose the better model for each query.
        oracle_best = min(e5_item["best_rank"], qwen_item["best_rank"])
        oracle_ranked = []
        if oracle_best <= 10:
            # A synthetic list where a relevant item appears at the oracle rank.
            oracle_ranked = [
                f"nonrelevant:{query_id}:{index}"
                for index in range(1, oracle_best)
            ] + [relevant_ids[0]]
        else:
            oracle_ranked = [
                f"nonrelevant:{query_id}:{index}" for index in range(1, 11)
            ]
        oracle_items.append(
            {
                "id": query_id,
                "relevant_ids": relevant_ids,
                "ranked_ids": oracle_ranked,
            }
        )

        if e5_item["best_rank"] != qwen_item["best_rank"]:
            disagreements.append(
                {
                    "id": query_id,
                    "query": e5_item["query"],
                    "relevant_ids": relevant_ids,
                    "e5_best_rank": e5_item["best_rank"],
                    "qwen_best_rank": qwen_item["best_rank"],
                    "e5_top_10": e5_item["top_10"],
                    "qwen_top_10": qwen_item["top_10"],
                    "rrf_top_10": fused[:10],
                }
            )

    fusion_metrics = evaluate_rankings(fused_eval_items)
    oracle_metrics = evaluate_rankings(oracle_items)

    review_lines = [
        "# Sidekick retrieval bake-off review",
        "",
        f"Source report: `{report_path}`",
        "",
        "## Metric summary",
        "",
        "| Retrieval path | Recall@1 | Recall@5 | Recall@10 | MRR | nDCG@10 |",
        "|---|---:|---:|---:|---:|---:|",
        (
            f"| E5 CPU | {fmt(e5['recall_at_1'])} | {fmt(e5['recall_at_5'])} | "
            f"{fmt(e5['recall_at_10'])} | {fmt(e5['mrr'])} | "
            f"{fmt(e5['ndcg_at_10'])} |"
        ),
        (
            f"| Qwen NPU | {fmt(qwen['recall_at_1'])} | {fmt(qwen['recall_at_5'])} | "
            f"{fmt(qwen['recall_at_10'])} | {fmt(qwen['mrr'])} | "
            f"{fmt(qwen['ndcg_at_10'])} |"
        ),
        (
            f"| RRF fusion (top-10 union) | {fmt(fusion_metrics['recall_at_1'])} | "
            f"{fmt(fusion_metrics['recall_at_5'])} | "
            f"{fmt(fusion_metrics['recall_at_10'])} | "
            f"{fmt(fusion_metrics['mrr'])} | "
            f"{fmt(fusion_metrics['ndcg_at_10'])} |"
        ),
        (
            f"| Perfect-router upper bound | {fmt(oracle_metrics['recall_at_1'])} | "
            f"{fmt(oracle_metrics['recall_at_5'])} | "
            f"{fmt(oracle_metrics['recall_at_10'])} | "
            f"{fmt(oracle_metrics['mrr'])} | "
            f"{fmt(oracle_metrics['ndcg_at_10'])} |"
        ),
        "",
        "The perfect-router row is diagnostic only; it is not a deployable method.",
        "",
        "## Disagreement review",
        "",
        (
            "Review whether the labeled relevant section is correct and whether "
            "either model returned a genuinely useful neighboring section. "
            "Large ranks can reflect label or chunk-boundary noise."
        ),
        "",
    ]

    for item in sorted(
        disagreements,
        key=lambda value: abs(value["e5_best_rank"] - value["qwen_best_rank"]),
        reverse=True,
    ):
        review_lines.extend(
            [
                f"### {item['id']}",
                "",
                f"**Query:** {item['query']}",
                "",
                f"**Labeled relevant IDs:** `{', '.join(item['relevant_ids'])}`",
                "",
                (
                    f"**Best labeled rank:** E5 `{item['e5_best_rank']}`; "
                    f"Qwen `{item['qwen_best_rank']}`"
                ),
                "",
                "#### E5 top results",
                "",
            ]
        )
        for row in item["e5_top_10"][:5]:
            marker = " **[labeled relevant]**" if row.get("relevant") else ""
            review_lines.append(
                f"{row['rank']}. `{row['source']} — {row['heading']}` "
                f"(score {row['score']:.6f}){marker}\n"
                f"   {row['preview']}"
            )

        review_lines.extend(["", "#### Qwen top results", ""])
        for row in item["qwen_top_10"][:5]:
            marker = " **[labeled relevant]**" if row.get("relevant") else ""
            review_lines.append(
                f"{row['rank']}. `{row['source']} — {row['heading']}` "
                f"(score {row['score']:.6f}){marker}\n"
                f"   {row['preview']}"
            )

        review_lines.extend(["", "#### RRF fused top results", ""])
        for rank, row in enumerate(item["rrf_top_10"][:5], start=1):
            marker = " **[labeled relevant]**" if row.get("relevant") else ""
            review_lines.append(
                f"{rank}. `{row['source']} — {row['heading']}` "
                f"(RRF {row['rrf_score']:.8f}; "
                f"E5 rank {row['e5_rank']}; Qwen rank {row['qwen_rank']})"
                f"{marker}\n"
                f"   {row['preview']}"
            )

        review_lines.extend(
            [
                "",
                "**Human judgment:** [ ] E5 better  [ ] Qwen better  "
                "[ ] Both useful  [ ] Label/chunk issue",
                "",
                "---",
                "",
            ]
        )

    review_path = output_dir / "disagreement-review.md"
    review_path.write_text("\n".join(review_lines), encoding="utf-8")

    summary = {
        "source_report": str(report_path),
        "rrf_k": args.rrf_k,
        "query_count": len(query_ids),
        "disagreement_count": len(disagreements),
        "e5": {
            key: e5[key]
            for key in ("recall_at_1", "recall_at_5", "recall_at_10", "mrr", "ndcg_at_10")
        },
        "qwen": {
            key: qwen[key]
            for key in ("recall_at_1", "recall_at_5", "recall_at_10", "mrr", "ndcg_at_10")
        },
        "rrf_fusion_top10_union": fusion_metrics,
        "perfect_router_upper_bound": oracle_metrics,
    }
    summary_path = output_dir / "fusion-summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"QUERY_COUNT={len(query_ids)}")
    print(f"DISAGREEMENT_COUNT={len(disagreements)}")
    print(f"RRF_RECALL_AT_1={fusion_metrics['recall_at_1']:.6f}")
    print(f"RRF_RECALL_AT_5={fusion_metrics['recall_at_5']:.6f}")
    print(f"RRF_RECALL_AT_10={fusion_metrics['recall_at_10']:.6f}")
    print(f"RRF_MRR={fusion_metrics['mrr']:.6f}")
    print(f"RRF_NDCG_AT_10={fusion_metrics['ndcg_at_10']:.6f}")
    print(f"ORACLE_RECALL_AT_1={oracle_metrics['recall_at_1']:.6f}")
    print(f"ORACLE_RECALL_AT_5={oracle_metrics['recall_at_5']:.6f}")
    print(f"ORACLE_RECALL_AT_10={oracle_metrics['recall_at_10']:.6f}")
    print(f"ORACLE_MRR={oracle_metrics['mrr']:.6f}")
    print(f"REVIEW={review_path}")
    print(f"SUMMARY={summary_path}")
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
