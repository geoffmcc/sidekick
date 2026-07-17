E5-small-v2 compact baseline spike

Files:
- provision-e5-small-v2.py
- e5-real-text-child.py
- run-e5-real-text.py

The provisioner:
- resolves and pins the current Hugging Face repository SHA
- downloads only the qINT8 OpenVINO IR and tokenizer/config files
- copies the selected IR to standard openvino_model.xml/.bin names
- hashes every downloaded/runtime file into source-manifest.json

The correctness test:
- uses query: and passage: prefixes
- uses attention-mask-aware mean pooling
- L2-normalizes 384-dimensional embeddings
- runs CPU and explicit NPU in separate child processes
- compares CPU/NPU numerical agreement and retrieval ranking
- does not touch Sidekick or Qdrant
