Qwen profile compatibility test

Compares the existing real-text result files for:
- CPU 128
- CPU 512
- NPU 128
- NPU 512

It verifies:
- identical text ordering and token counts
- same-text cosine similarity across 128/512 profiles
- CPU/NPU fallback compatibility across profiles
- retrieval ranking when queries and documents use different profiles
- retrieval ranking when CPU and NPU outputs are mixed

Expected sibling directory:
../qwen-real-text-correctness/probe-results
