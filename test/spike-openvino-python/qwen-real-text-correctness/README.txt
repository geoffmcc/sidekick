Qwen3 real-text correctness diagnostic

Purpose
-------
Tests the complete local text-to-embedding path through Python OpenVINO:

- local Hugging Face tokenizer files only
- trust_remote_code=False
- left padding
- documented Qwen query instruction format
- input_ids and attention_mask
- last-token pooling
- L2 normalization
- CPU versus explicit NPU execution
- official Qwen sanity-ranking examples
- small Sidekick-like retrieval examples
- per-text CPU/NPU cosine agreement

It does not touch Sidekick, Qdrant, or any production database.

Required packages in the isolated Python environment
----------------------------------------------------
openvino==2026.2.1
numpy
transformers==4.57.6

Run
---
python run-qwen-real-text.py <model-dir> 512 900000
