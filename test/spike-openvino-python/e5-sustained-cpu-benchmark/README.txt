E5 sustained CPU benchmark

Runs a 1,000-iteration end-to-end embedding workload through Python OpenVINO.

Measures:
- tokenizer latency
- inference latency
- end-to-end latency
- p50, p95, and p99
- throughput
- RSS/VMS growth at checkpoints
- output determinism
- embedding dimension

This does not touch Sidekick, Qdrant, or production data.
