Sidekick documentation retrieval bake-off

Purpose
-------
Builds a labeled retrieval benchmark directly from the Sidekick repository
documentation and compares:

- E5-small-v2 qINT8 on CPU
- Qwen3-Embedding-0.6B INT8 on Intel NPU using the certified [1,128] profile

Safety and scope
----------------
- Reads docs/*.md only.
- Does not read the Sidekick SQLite database.
- Does not contact Qdrant.
- Does not modify the repository.
- Loads tokenizers from local model directories only.
- Uses trust_remote_code=False.
- Excludes docs/adr-openvino-integration.md because the attached snapshot's ADR
  predates the completed spike and contains architecture decisions disproved by
  the measured results.

Outputs
-------
probe-results/sidekick-doc-corpus.jsonl
probe-results/sidekick-doc-queries.json
probe-results/sidekick-doc-bakeoff-report.json

Metrics
-------
Recall@1, Recall@5, Recall@10, MRR, and nDCG@10, plus per-query top-10 results
and rank disagreements.
