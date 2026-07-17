#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

REPO_ID = "intfloat/e5-small-v2"
TARGET_NAME = "e5-small-v2-qint8-ov"

ALLOW_PATTERNS = [
    "openvino/openvino_model_qint8_quantized.xml",
    "openvino/openvino_model_qint8_quantized.bin",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "sentence_bert_config.json",
    "modules.json",
    "1_Pooling/*",
    "README.md",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    here = Path(__file__).resolve().parent
    target = here / "models" / TARGET_NAME
    target.mkdir(parents=True, exist_ok=True)

    api = HfApi()
    info = api.model_info(REPO_ID)
    revision = info.sha
    if not revision:
        raise RuntimeError("Hugging Face did not return a repository revision")

    print(f"REPO_ID={REPO_ID}", flush=True)
    print(f"PINNED_REVISION={revision}", flush=True)
    print(f"TARGET={target}", flush=True)

    snapshot_download(
        repo_id=REPO_ID,
        revision=revision,
        local_dir=str(target),
        allow_patterns=ALLOW_PATTERNS,
    )

    src_xml = target / "openvino" / "openvino_model_qint8_quantized.xml"
    src_bin = target / "openvino" / "openvino_model_qint8_quantized.bin"
    if not src_xml.is_file() or not src_bin.is_file():
        raise FileNotFoundError("Pinned repository did not contain the expected qINT8 OpenVINO IR")

    shutil.copy2(src_xml, target / "openvino_model.xml")
    shutil.copy2(src_bin, target / "openvino_model.bin")

    files = []
    for path in sorted(p for p in target.rglob("*") if p.is_file()):
        rel = path.relative_to(target).as_posix()
        files.append(
            {
                "path": rel,
                "size_bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )

    manifest = {
        "repo_id": REPO_ID,
        "revision": revision,
        "license": "mit",
        "selected_ir": {
            "source_xml": "openvino/openvino_model_qint8_quantized.xml",
            "source_bin": "openvino/openvino_model_qint8_quantized.bin",
            "runtime_xml": "openvino_model.xml",
            "runtime_bin": "openvino_model.bin",
        },
        "files": files,
    }
    manifest_path = target / "source-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"FILES={len(files)}", flush=True)
    print(f"MANIFEST={manifest_path}", flush=True)
    print("PASS", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
