Qwen3 sustained NPU benchmark

Runs a persistent Python OpenVINO Qwen3-Embedding-0.6B INT8 workload.

Measures:
- tokenizer latency
- NPU inference latency
- end-to-end latency
- p50, p95, p99
- throughput
- RSS and VMS growth
- deterministic repeated output
- 1024-dimensional embedding output

This does not touch Sidekick, Qdrant, or production data.
