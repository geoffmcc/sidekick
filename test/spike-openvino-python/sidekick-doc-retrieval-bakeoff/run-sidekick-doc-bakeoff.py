#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import openvino as ov
from transformers import AutoTokenizer


QWEN_TASK = (
    "Given a user query, retrieve the most relevant passage that answers "
    "the query or contains the needed technical information"
)

# The current OpenVINO ADR in the attached snapshot predates the completed
# compatibility spike and contains decisions that the spike disproved.
# Excluding it prevents stale architecture text from becoming benchmark truth.
EXCLUDED_DOCS = {"adr-openvino-integration.md"}

QUERY_SPECS: list[dict[str, Any]] = [
    {
        "id": "runtime_ports",
        "query": "Which ports do the Sidekick MCP server, dashboard, and Agent Bridge use?",
        "targets": [{"source": "README.md", "heading": "Runtime services"}],
    },
    {
        "id": "agent_information_access",
        "query": "Where should an agent look for authoritative Sidekick operational knowledge?",
        "targets": [{"source": "README.md", "heading": "Agent Information Access"}],
    },
    {
        "id": "sidekick_core_idea",
        "query": "What does Sidekick provide to a connected MCP client or assistant?",
        "targets": [{"source": "overview.md", "heading": "Core idea"}],
    },
    {
        "id": "main_components",
        "query": "What services and major components make up Sidekick?",
        "targets": [{"source": "overview.md", "heading": "Main components"}],
    },
    {
        "id": "recommended_exposure",
        "query": "How should a Sidekick server be exposed safely to remote clients?",
        "targets": [{"source": "overview.md", "heading": "Recommended operating model"}],
    },
    {
        "id": "mcp_server_boundary",
        "query": "What endpoints and responsibilities belong to the MCP server?",
        "targets": [{"source": "architecture.md", "heading": "MCP server: `src/index.js`"}],
    },
    {
        "id": "tool_runtime",
        "query": "Where is the authoritative tool registry and dispatcher implemented?",
        "targets": [{"source": "architecture.md", "heading": "Tool runtime: `src/tools/`"}],
    },
    {
        "id": "evolve_architecture",
        "query": "How does Evolve analyze workflows and create generated tools?",
        "targets": [{"source": "architecture.md", "heading": "Evolve and dynamic tools"}],
    },
    {
        "id": "approval_recovery",
        "query": "How do platform guards prevent invalid or duplicate execution transitions?",
        "targets": [
            {
                "source": "architecture.md",
                "heading": "Authoritative execution control: `platformGuard` and `findActiveExecution`",
            }
        ],
    },
    {
        "id": "capability_rbac",
        "query": "How are actor capabilities and immutable approval records managed?",
        "targets": [
            {
                "source": "architecture.md",
                "heading": "Capability/RBAC and immutable change-set approvals",
            }
        ],
    },
    {
        "id": "workflow_engine",
        "query": "How does Sidekick represent and execute durable multi-step workflows?",
        "targets": [
            {
                "source": "architecture.md",
                "heading": "Durable workflow engine and isolated runner sessions",
            }
        ],
    },
    {
        "id": "project_workspaces",
        "query": "How do project workspaces isolate configuration, secrets, and resources?",
        "targets": [
            {
                "source": "architecture.md",
                "heading": "Project workspaces and model registry",
            }
        ],
    },
    {
        "id": "backup_records",
        "query": "How does the platform kernel track backup and restore operations?",
        "targets": [
            {
                "source": "architecture.md",
                "heading": "Backup/restore and release maturity",
            }
        ],
    },
    {
        "id": "session_expiry",
        "query": "What happens to inactive or stale MCP sessions?",
        "targets": [{"source": "architecture.md", "heading": "Session handling"}],
    },
    {
        "id": "shared_storage",
        "query": "Where do Sidekick services store shared durable state?",
        "targets": [{"source": "architecture.md", "heading": "Shared storage"}],
    },
    {
        "id": "automatic_memory_config",
        "query": "Which settings control automatic memory and embeddings?",
        "targets": [{"source": "configuration.md", "heading": "Automatic Memory"}],
    },
    {
        "id": "tool_policy_config",
        "query": "How are Sidekick tool allowlists, blocklists, and risk policies configured?",
        "targets": [{"source": "configuration.md", "heading": "Security and tool policy"}],
    },
    {
        "id": "sqlite_schema",
        "query": "What important data is stored in the Sidekick SQLite schema?",
        "targets": [{"source": "data-model.md", "heading": "SQLite schema"}],
    },
    {
        "id": "memory_conflicts",
        "query": "How does Sidekick detect conflicting memories and supersede old facts?",
        "targets": [
            {
                "source": "data-model.md",
                "heading": "Conflict Detection and Supersession",
            }
        ],
    },
    {
        "id": "memory_lifecycle",
        "query": "How are memories expired, disabled, restored, or otherwise managed over time?",
        "targets": [{"source": "data-model.md", "heading": "Memory Lifecycle"}],
    },
    {
        "id": "memory_sync",
        "query": "How are structured memories synchronized between Sidekick machines?",
        "targets": [{"source": "data-model.md", "heading": "Cross-Machine Sync"}],
    },
    {
        "id": "knowledge_base",
        "query": "What is the Sidekick knowledge base used for?",
        "targets": [{"source": "data-model.md", "heading": "Knowledge base"}],
    },
    {
        "id": "backup_guidance",
        "query": "What files and directories must be included in a Sidekick backup?",
        "targets": [{"source": "data-model.md", "heading": "Backup guidance"}],
    },
    {
        "id": "durable_active_zero",
        "query": "Why could the dashboard show many Operational memories but zero Durable Active memories?",
        "targets": [
            {
                "source": "memory-intelligence-findings.md",
                "heading": "Dashboard Number Explanation",
            }
        ],
    },
    {
        "id": "memory_types",
        "query": "What structured memory types does Sidekick support?",
        "targets": [{"source": "structured-memory-plan.md", "heading": "Memory Types"}],
    },
    {
        "id": "memory_classes",
        "query": "What are semantic, episodic, procedural, working, and prospective memory classes?",
        "targets": [{"source": "structured-memory-plan.md", "heading": "Memory Classes"}],
    },
    {
        "id": "memory_remaining_work",
        "query": "What work remains for Sidekick memory intelligence?",
        "targets": [
            {
                "source": "structured-memory-plan.md",
                "heading": "Remaining Logical Steps",
            }
        ],
    },
    {
        "id": "agent_task_lifecycle",
        "query": "How does an Agent Bridge task move from request through tool calls to completion?",
        "targets": [{"source": "agent-bridge.md", "heading": "Task lifecycle"}],
    },
    {
        "id": "agent_conversation_retention",
        "query": "Where are Agent Bridge conversations and transcripts retained?",
        "targets": [{"source": "agent-bridge.md", "heading": "Conversation retention"}],
    },
    {
        "id": "agent_safety_limits",
        "query": "What prevents the Agent Bridge from looping forever?",
        "targets": [{"source": "agent-bridge.md", "heading": "Safety limits"}],
    },
    {
        "id": "compute_enrollment",
        "query": "How are distributed Compute workers enrolled and authenticated?",
        "targets": [{"source": "compute.md", "heading": "Enrollment And Workers"}],
    },
    {
        "id": "compute_leases",
        "query": "How are Compute jobs claimed, leased, retried, and recovered?",
        "targets": [{"source": "compute.md", "heading": "Jobs And Leasing"}],
    },
    {
        "id": "compute_results",
        "query": "How does Sidekick Compute handle results and artifacts?",
        "targets": [{"source": "compute.md", "heading": "Results And Artifacts"}],
    },
    {
        "id": "compute_cancellation",
        "query": "What happens when a Compute job is cancelled or a worker disappears?",
        "targets": [{"source": "compute.md", "heading": "Cancellation And Recovery"}],
    },
    {
        "id": "compute_trust",
        "query": "What are the trust boundaries for Sidekick Compute workers?",
        "targets": [{"source": "compute.md", "heading": "Trust Boundaries"}],
    },
    {
        "id": "dashboard_auth",
        "query": "How is the Sidekick dashboard authenticated and protected?",
        "targets": [{"source": "dashboard.md", "heading": "Authentication and protections"}],
    },
    {
        "id": "dashboard_data_editing",
        "query": "What persistent data can be inspected or edited from the dashboard?",
        "targets": [{"source": "dashboard.md", "heading": "Data editing"}],
    },
    {
        "id": "blackbox_capture",
        "query": "How do I capture a time-limited incident bundle with Sidekick?",
        "targets": [{"source": "blackbox.md", "heading": "MCP Actions"}],
    },
    {
        "id": "blackbox_retention",
        "query": "How are Black Box incident captures retained and cleaned up?",
        "targets": [{"source": "blackbox.md", "heading": "Retention"}],
    },
    {
        "id": "blackbox_security",
        "query": "What is the security model for Black Box incident data?",
        "targets": [{"source": "blackbox.md", "heading": "Security Model"}],
    },
    {
        "id": "predict_evidence",
        "query": "What evidence sources does Sidekick Predict evaluate?",
        "targets": [{"source": "predict.md", "heading": "Evidence Sources"}],
    },
    {
        "id": "predict_confidence",
        "query": "How does Sidekick assign confidence to predictions?",
        "targets": [{"source": "predict.md", "heading": "Confidence"}],
    },
    {
        "id": "mcp_authentication",
        "query": "How is the MCP endpoint authenticated?",
        "targets": [{"source": "security.md", "heading": "MCP authentication"}],
    },
    {
        "id": "filesystem_guardrails",
        "query": "How does Sidekick prevent tools from escaping allowed filesystem paths?",
        "targets": [{"source": "security.md", "heading": "Filesystem path guardrails"}],
    },
    {
        "id": "database_query_safety",
        "query": "What protections apply to database queries executed through Sidekick?",
        "targets": [{"source": "security.md", "heading": "Database query safety"}],
    },
    {
        "id": "redaction",
        "query": "How does Sidekick redact secrets from logs and returned output?",
        "targets": [{"source": "security.md", "heading": "Redaction"}],
    },
    {
        "id": "secret_storage",
        "query": "Where should credentials and other secrets be stored?",
        "targets": [{"source": "security.md", "heading": "Secret storage"}],
    },
    {
        "id": "approval_queue",
        "query": "How does the approval queue protect risky tool operations?",
        "targets": [{"source": "security.md", "heading": "Approval queue"}],
    },
    {
        "id": "service_commands",
        "query": "What commands restart Sidekick and inspect service status or logs?",
        "targets": [{"source": "operations.md", "heading": "Service commands"}],
    },
    {
        "id": "health_checks",
        "query": "How do I check whether the Sidekick services are healthy?",
        "targets": [{"source": "operations.md", "heading": "Health checks"}],
    },
    {
        "id": "dashboard_api_failure",
        "query": "What should I check when the dashboard loads but its API calls fail?",
        "targets": [
            {
                "source": "operations.md",
                "heading": "Dashboard loads but API calls fail",
            }
        ],
    },
    {
        "id": "agent_not_progressing",
        "query": "What should I troubleshoot when Agent Bridge tasks do not progress?",
        "targets": [
            {
                "source": "operations.md",
                "heading": "Agent tasks do not progress",
            }
        ],
    },
    {
        "id": "add_builtin_tool",
        "query": "What is the supported process for adding or migrating a built-in tool?",
        "targets": [{"source": "development.md", "heading": "Adding or migrating a tool"}],
    },
    {
        "id": "development_safety",
        "query": "What implementation safety practices should tool developers follow?",
        "targets": [{"source": "development.md", "heading": "Implementation notes"}],
    },
    {
        "id": "tool_dispatcher",
        "query": "What steps does the centralized tool dispatcher perform for each invocation?",
        "targets": [{"source": "tool-architecture.md", "heading": "Dispatcher Pipeline"}],
    },
    {
        "id": "tool_risk",
        "query": "How do tool risk levels interact with policy and approval requirements?",
        "targets": [{"source": "tool-architecture.md", "heading": "Risk Behavior"}],
    },
    {
        "id": "persistent_context_tool",
        "query": "Which Sidekick tools should an agent use for persistent project memory and recall?",
        "targets": [{"source": "tool-usage-guide.md", "heading": "Persistent memory"}],
    },
    {
        "id": "safe_experimentation",
        "query": "Which tools provide backup, rollback, and before-and-after snapshots for risky experiments?",
        "targets": [{"source": "tool-usage-guide.md", "heading": "Safe experimentation"}],
    },
    {
        "id": "ollama_default",
        "query": "What local Ollama model is recommended by default for Sidekick?",
        "targets": [{"source": "ollama.md", "heading": "Recommended Default Model"}],
    },
    {
        "id": "ollama_running",
        "query": "How do I see which Ollama models are installed and currently running?",
        "targets": [
            {"source": "ollama.md", "heading": "Confirm Installed Models"},
            {"source": "ollama.md", "heading": "Show Running Models"},
        ],
    },
    {
        "id": "deployment_scripts",
        "query": "How do the supplied deployment scripts install Sidekick?",
        "targets": [{"source": "installation.md", "heading": "Deployment scripts"}],
    },
    {
        "id": "mcp_client_config",
        "query": "What URL and bearer-token configuration should an MCP client use?",
        "targets": [{"source": "installation.md", "heading": "MCP client configuration"}],
    },
    {
        "id": "firewall_exposure",
        "query": "Which Sidekick ports should be exposed through the firewall?",
        "targets": [{"source": "installation.md", "heading": "Firewall and exposure"}],
    },
]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def slug(value: str) -> str:
    normalized = re.sub(r"`([^`]*)`", r"\1", value)
    normalized = re.sub(r"[^A-Za-z0-9]+", "-", normalized).strip("-").lower()
    return normalized or "section"


def clean_markdown(text: str) -> str:
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"<https?://[^>]+>", " ", text)
    text = text.replace("```", "\n")
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"\|?\s*:?-{3,}:?\s*(?:\||$)", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_markdown_sections(path: Path) -> list[dict[str, Any]]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    heading_stack: list[str] = []
    current_heading_path: list[str] = []
    buffer: list[str] = []
    sections: list[dict[str, Any]] = []

    def emit() -> None:
        nonlocal buffer
        content = clean_markdown("\n".join(buffer))
        if content:
            sections.append(
                {
                    "source": path.name,
                    "heading_path": list(current_heading_path),
                    "content": content,
                }
            )
        buffer = []

    for line in lines:
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if not match:
            buffer.append(line)
            continue

        emit()
        level = len(match.group(1))
        title = match.group(2).strip()
        heading_stack = heading_stack[: level - 1]
        heading_stack.append(title)
        current_heading_path = list(heading_stack)

    emit()
    return sections


def token_count(tokenizer, text: str) -> int:
    encoded = tokenizer(
        text,
        add_special_tokens=True,
        truncation=False,
        return_attention_mask=False,
    )
    return len(encoded["input_ids"])


def split_oversized_piece(tokenizer, text: str, max_tokens: int) -> list[str]:
    words = text.split()
    pieces: list[str] = []
    current: list[str] = []

    for word in words:
        candidate = " ".join([*current, word])
        if current and token_count(tokenizer, candidate) > max_tokens:
            pieces.append(" ".join(current))
            current = [word]
        else:
            current.append(word)

    if current:
        pieces.append(" ".join(current))

    for piece in pieces:
        if token_count(tokenizer, piece) > max_tokens:
            raise RuntimeError(
                "Could not split an oversized token sequence. "
                f"First 120 characters: {piece[:120]!r}"
            )
    return pieces


def split_section(
    tokenizer,
    source: str,
    heading_path: list[str],
    content: str,
    max_tokens: int,
) -> list[str]:
    heading = " > ".join(heading_path) if heading_path else source
    prefix = f"Document: {source}\nSection: {heading}\n"

    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", content) if part.strip()]
    atomic: list[str] = []

    for paragraph in paragraphs:
        if token_count(tokenizer, prefix + paragraph) <= max_tokens:
            atomic.append(paragraph)
            continue

        sentences = [
            part.strip()
            for part in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9`])", paragraph)
            if part.strip()
        ]
        if len(sentences) <= 1:
            atomic.extend(
                split_oversized_piece(
                    tokenizer,
                    paragraph,
                    max(16, max_tokens - token_count(tokenizer, prefix)),
                )
            )
            continue

        for sentence in sentences:
            if token_count(tokenizer, prefix + sentence) <= max_tokens:
                atomic.append(sentence)
            else:
                atomic.extend(
                    split_oversized_piece(
                        tokenizer,
                        sentence,
                        max(16, max_tokens - token_count(tokenizer, prefix)),
                    )
                )

    chunks: list[str] = []
    current: list[str] = []
    for piece in atomic:
        candidate_body = "\n\n".join([*current, piece])
        if current and token_count(tokenizer, prefix + candidate_body) > max_tokens:
            chunks.append(prefix + "\n\n".join(current))
            current = [piece]
        else:
            current.append(piece)

    if current:
        chunks.append(prefix + "\n\n".join(current))

    for chunk in chunks:
        count = token_count(tokenizer, chunk)
        if count > max_tokens:
            raise RuntimeError(
                f"Chunk exceeds {max_tokens} tokens ({count}): {source} / {heading}"
            )
    return chunks


def build_corpus(repo_dir: Path, qwen_tokenizer, max_tokens: int = 120) -> list[dict[str, Any]]:
    docs_dir = repo_dir / "docs"
    if not docs_dir.is_dir():
        raise FileNotFoundError(f"Missing docs directory: {docs_dir}")

    records: list[dict[str, Any]] = []
    for path in sorted(docs_dir.glob("*.md")):
        if path.name in EXCLUDED_DOCS:
            continue

        for section in parse_markdown_sections(path):
            heading_path = section["heading_path"]
            heading = heading_path[-1] if heading_path else path.stem
            chunks = split_section(
                qwen_tokenizer,
                path.name,
                heading_path,
                section["content"],
                max_tokens,
            )
            for index, text in enumerate(chunks):
                record_id = (
                    f"docs:{path.name}:{slug(' > '.join(heading_path) or path.stem)}:"
                    f"{index + 1}"
                )
                records.append(
                    {
                        "id": record_id,
                        "source": path.name,
                        "heading": heading,
                        "heading_path": heading_path,
                        "chunk_index": index + 1,
                        "text": text,
                        "qwen_tokens": token_count(qwen_tokenizer, text),
                    }
                )

    if not records:
        raise RuntimeError("Corpus build produced no records")
    return records


def resolve_queries(
    corpus: list[dict[str, Any]],
    query_specs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    for spec in query_specs:
        relevant: set[str] = set()
        for target in spec["targets"]:
            for record in corpus:
                if record["source"] != target["source"]:
                    continue
                heading_target = target["heading"]
                if heading_target in record["heading_path"]:
                    relevant.add(record["id"])

        if not relevant:
            raise RuntimeError(
                f"Query {spec['id']!r} has no corpus target: {spec['targets']}"
            )

        resolved.append(
            {
                "id": spec["id"],
                "query": spec["query"],
                "targets": spec["targets"],
                "relevant_ids": sorted(relevant),
            }
        )
    return resolved


def choose_rank3_output(outputs: dict[Any, Any]) -> np.ndarray:
    candidates = []
    for value in outputs.values():
        array = np.asarray(value)
        if array.ndim == 3:
            candidates.append(array)
    if len(candidates) != 1:
        shapes = [list(np.asarray(value).shape) for value in outputs.values()]
        raise RuntimeError(f"Expected one rank-3 output; observed {shapes}")
    return np.asarray(candidates[0], dtype=np.float32)


def l2_normalize(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError(f"Invalid embedding norm: {norm}")
    return vector / norm


class E5Embedder:
    def __init__(self, model_dir: Path, sequence_length: int = 512):
        self.model_dir = model_dir.resolve()
        self.sequence_length = sequence_length
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(self.model_dir),
            local_files_only=True,
            trust_remote_code=False,
            use_fast=True,
        )
        self.core = ov.Core()
        model = self.core.read_model(str(self.model_dir / "openvino_model.xml"))
        reshape = {}
        self.input_names = []
        for port in model.inputs:
            name = port.get_any_name()
            self.input_names.append(name)
            if name in {"input_ids", "attention_mask", "token_type_ids"}:
                reshape[port] = [1, sequence_length]
        model.reshape(reshape)
        started = time.perf_counter()
        self.compiled = self.core.compile_model(model, "CPU")
        self.compile_ms = (time.perf_counter() - started) * 1000
        self.request = self.compiled.create_infer_request()

    def embed(self, text: str, *, is_query: bool) -> np.ndarray:
        value = f"{'query' if is_query else 'passage'}: {text}"
        encoded = self.tokenizer(
            value,
            padding="max_length",
            truncation=False,
            max_length=self.sequence_length,
            return_attention_mask=True,
            return_tensors="np",
        )
        tokens = {
            key: np.asarray(item, dtype=np.int64)
            for key, item in encoded.items()
        }
        if tokens["input_ids"].shape[1] > self.sequence_length:
            raise RuntimeError("E5 input exceeded the certified 512-token profile")

        infer_inputs = {}
        for name in self.input_names:
            if name in tokens:
                infer_inputs[name] = tokens[name]
            elif name == "token_type_ids":
                infer_inputs[name] = np.zeros(
                    (1, self.sequence_length), dtype=np.int64
                )
            else:
                raise RuntimeError(f"Missing E5 input {name}")

        outputs = self.request.infer(
            infer_inputs,
            share_inputs=False,
            share_outputs=False,
        )
        hidden = choose_rank3_output(outputs)
        mask = tokens["attention_mask"].astype(np.float32)[..., None]
        pooled = (hidden * mask).sum(axis=1) / mask.sum(axis=1)
        return l2_normalize(pooled[0])


class QwenEmbedder:
    def __init__(self, model_dir: Path, sequence_length: int = 128):
        self.model_dir = model_dir.resolve()
        self.sequence_length = sequence_length
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(self.model_dir),
            local_files_only=True,
            trust_remote_code=False,
            use_fast=True,
            padding_side="left",
            fix_mistral_regex=True,
        )
        self.tokenizer.padding_side = "left"
        self.core = ov.Core()
        model = self.core.read_model(str(self.model_dir / "openvino_model.xml"))
        reshape = {}
        self.input_names = []
        for port in model.inputs:
            name = port.get_any_name()
            self.input_names.append(name)
            if name in {"input_ids", "attention_mask"}:
                reshape[port] = [1, sequence_length]
        model.reshape(reshape)
        started = time.perf_counter()
        self.compiled = self.core.compile_model(model, "NPU")
        self.compile_ms = (time.perf_counter() - started) * 1000
        self.request = self.compiled.create_infer_request()

    def embed(self, text: str, *, is_query: bool) -> np.ndarray:
        value = (
            f"Instruct: {QWEN_TASK}\nQuery:{text}"
            if is_query
            else text
        )
        tokenized_unpadded = self.tokenizer(
            value,
            padding=False,
            truncation=False,
            return_attention_mask=True,
        )
        actual_tokens = len(tokenized_unpadded["input_ids"])
        if actual_tokens > self.sequence_length:
            raise RuntimeError(
                f"Qwen input requires {actual_tokens} tokens, exceeding "
                f"the certified {self.sequence_length}-token profile"
            )

        encoded = self.tokenizer(
            value,
            padding="max_length",
            truncation=False,
            max_length=self.sequence_length,
            return_attention_mask=True,
            return_tensors="np",
        )
        tokens = {
            key: np.asarray(item, dtype=np.int64)
            for key, item in encoded.items()
        }

        outputs = self.request.infer(
            {
                "input_ids": tokens["input_ids"],
                "attention_mask": tokens["attention_mask"],
            },
            share_inputs=False,
            share_outputs=False,
        )
        hidden = choose_rank3_output(outputs)
        mask = tokens["attention_mask"]
        if bool(np.all(mask[:, -1] == 1)):
            pooled = hidden[:, -1, :]
        else:
            lengths = mask.sum(axis=1) - 1
            pooled = hidden[np.arange(hidden.shape[0]), lengths]
        return l2_normalize(pooled[0])


def embed_records(
    embedder,
    records: list[dict[str, Any]],
    *,
    is_query: bool,
    label: str,
) -> tuple[np.ndarray, dict[str, float]]:
    vectors = []
    latencies = []
    total = len(records)
    for index, record in enumerate(records, start=1):
        started = time.perf_counter()
        vectors.append(embedder.embed(record["query" if is_query else "text"], is_query=is_query))
        latencies.append((time.perf_counter() - started) * 1000)
        if index == 1 or index % 25 == 0 or index == total:
            print(f"{label}_PROGRESS={index}/{total}", flush=True)

    return np.stack(vectors), {
        "median_ms": float(statistics.median(latencies)),
        "p95_ms": float(np.percentile(latencies, 95)),
        "mean_ms": float(statistics.fmean(latencies)),
        "count": len(latencies),
    }


def ndcg_at_k(order: list[int], relevant: set[int], k: int) -> float:
    dcg = 0.0
    for rank, index in enumerate(order[:k], start=1):
        if index in relevant:
            dcg += 1.0 / math.log2(rank + 1)
    ideal_hits = min(len(relevant), k)
    if ideal_hits == 0:
        return 0.0
    idcg = sum(1.0 / math.log2(rank + 1) for rank in range(1, ideal_hits + 1))
    return dcg / idcg


def evaluate(
    name: str,
    corpus: list[dict[str, Any]],
    queries: list[dict[str, Any]],
    document_vectors: np.ndarray,
    query_vectors: np.ndarray,
) -> dict[str, Any]:
    id_to_index = {record["id"]: index for index, record in enumerate(corpus)}
    per_query = []
    reciprocal_ranks = []
    recall_1 = []
    recall_5 = []
    recall_10 = []
    ndcg_10 = []

    for query_index, query in enumerate(queries):
        scores = query_vectors[query_index] @ document_vectors.T
        order = np.argsort(-scores).tolist()
        relevant_indices = {
            id_to_index[record_id]
            for record_id in query["relevant_ids"]
        }
        ranks = [
            rank
            for rank, corpus_index in enumerate(order, start=1)
            if corpus_index in relevant_indices
        ]
        best_rank = min(ranks)
        reciprocal_ranks.append(1.0 / best_rank)
        recall_1.append(float(any(index in relevant_indices for index in order[:1])))
        recall_5.append(float(any(index in relevant_indices for index in order[:5])))
        recall_10.append(float(any(index in relevant_indices for index in order[:10])))
        ndcg_10.append(ndcg_at_k(order, relevant_indices, 10))

        top = []
        for rank, corpus_index in enumerate(order[:10], start=1):
            record = corpus[corpus_index]
            top.append(
                {
                    "rank": rank,
                    "id": record["id"],
                    "source": record["source"],
                    "heading": record["heading"],
                    "score": float(scores[corpus_index]),
                    "relevant": corpus_index in relevant_indices,
                    "preview": re.sub(r"\s+", " ", record["text"])[:240],
                }
            )

        per_query.append(
            {
                "id": query["id"],
                "query": query["query"],
                "relevant_ids": query["relevant_ids"],
                "best_rank": best_rank,
                "top_10": top,
            }
        )

    result = {
        "name": name,
        "query_count": len(queries),
        "corpus_count": len(corpus),
        "recall_at_1": float(np.mean(recall_1)),
        "recall_at_5": float(np.mean(recall_5)),
        "recall_at_10": float(np.mean(recall_10)),
        "mrr": float(np.mean(reciprocal_ranks)),
        "ndcg_at_10": float(np.mean(ndcg_10)),
        "per_query": per_query,
    }
    return result


def model_fingerprint(model_dir: Path) -> dict[str, Any]:
    files = []
    for name in (
        "openvino_model.xml",
        "openvino_model.bin",
        "tokenizer.json",
        "tokenizer_config.json",
        "config.json",
    ):
        path = model_dir / name
        if path.is_file():
            files.append(
                {
                    "path": name,
                    "size_bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    return {"directory": str(model_dir.resolve()), "files": files}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo_dir")
    parser.add_argument("e5_model_dir")
    parser.add_argument("qwen_model_dir")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parent / "probe-results"),
    )
    args = parser.parse_args()

    repo_dir = Path(args.repo_dir).resolve()
    e5_model_dir = Path(args.e5_model_dir).resolve()
    qwen_model_dir = Path(args.qwen_model_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"PYTHON={sys.version.replace(chr(10), ' ')}", flush=True)
    print(f"OPENVINO={ov.__version__}", flush=True)
    print(f"REPO={repo_dir}", flush=True)
    print(f"E5_MODEL={e5_model_dir}", flush=True)
    print(f"QWEN_MODEL={qwen_model_dir}", flush=True)
    print(f"EXCLUDED_DOCS={json.dumps(sorted(EXCLUDED_DOCS))}", flush=True)

    qwen_tokenizer = AutoTokenizer.from_pretrained(
        str(qwen_model_dir),
        local_files_only=True,
        trust_remote_code=False,
        use_fast=True,
        padding_side="left",
        fix_mistral_regex=True,
    )
    qwen_tokenizer.padding_side = "left"

    corpus = build_corpus(repo_dir, qwen_tokenizer, max_tokens=120)
    queries = resolve_queries(corpus, QUERY_SPECS)

    corpus_path = output_dir / "sidekick-doc-corpus.jsonl"
    corpus_path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in corpus),
        encoding="utf-8",
    )
    queries_path = output_dir / "sidekick-doc-queries.json"
    queries_path.write_text(json.dumps(queries, indent=2), encoding="utf-8")

    print(f"CORPUS_COUNT={len(corpus)}", flush=True)
    print(f"QUERY_COUNT={len(queries)}", flush=True)
    print(f"MAX_QWEN_DOCUMENT_TOKENS={max(r['qwen_tokens'] for r in corpus)}", flush=True)
    print(f"CORPUS={corpus_path}", flush=True)
    print(f"QUERIES={queries_path}", flush=True)

    e5 = E5Embedder(e5_model_dir, sequence_length=512)
    print(f"E5_COMPILE_MS={e5.compile_ms:.3f}", flush=True)
    e5_documents, e5_document_latency = embed_records(
        e5, corpus, is_query=False, label="E5_DOCUMENTS"
    )
    e5_queries, e5_query_latency = embed_records(
        e5, queries, is_query=True, label="E5_QUERIES"
    )
    e5_result = evaluate("e5-small-v2-qint8-cpu", corpus, queries, e5_documents, e5_queries)

    del e5

    qwen = QwenEmbedder(qwen_model_dir, sequence_length=128)
    print(f"QWEN_COMPILE_MS={qwen.compile_ms:.3f}", flush=True)
    qwen_documents, qwen_document_latency = embed_records(
        qwen, corpus, is_query=False, label="QWEN_DOCUMENTS"
    )
    qwen_queries, qwen_query_latency = embed_records(
        qwen, queries, is_query=True, label="QWEN_QUERIES"
    )
    qwen_result = evaluate(
        "qwen3-embedding-0.6b-int8-npu-128",
        corpus,
        queries,
        qwen_documents,
        qwen_queries,
    )

    corpus_hash = sha256_bytes(corpus_path.read_bytes())
    query_hash = sha256_bytes(queries_path.read_bytes())

    report = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version,
        "openvino": ov.__version__,
        "repo": str(repo_dir),
        "excluded_docs": sorted(EXCLUDED_DOCS),
        "corpus_count": len(corpus),
        "query_count": len(queries),
        "corpus_sha256": corpus_hash,
        "queries_sha256": query_hash,
        "models": {
            "e5": model_fingerprint(e5_model_dir),
            "qwen": model_fingerprint(qwen_model_dir),
        },
        "latency": {
            "e5_documents": e5_document_latency,
            "e5_queries": e5_query_latency,
            "qwen_documents": qwen_document_latency,
            "qwen_queries": qwen_query_latency,
        },
        "results": {
            "e5": e5_result,
            "qwen": qwen_result,
        },
    }

    report_path = output_dir / "sidekick-doc-bakeoff-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("\n=== QUALITY SUMMARY ===")
    for result in (e5_result, qwen_result):
        prefix = "E5" if result["name"].startswith("e5") else "QWEN"
        print(f"{prefix}_RECALL_AT_1={result['recall_at_1']:.6f}")
        print(f"{prefix}_RECALL_AT_5={result['recall_at_5']:.6f}")
        print(f"{prefix}_RECALL_AT_10={result['recall_at_10']:.6f}")
        print(f"{prefix}_MRR={result['mrr']:.6f}")
        print(f"{prefix}_NDCG_AT_10={result['ndcg_at_10']:.6f}")

    differences = []
    e5_by_id = {item["id"]: item for item in e5_result["per_query"]}
    qwen_by_id = {item["id"]: item for item in qwen_result["per_query"]}
    for query in queries:
        e5_rank = e5_by_id[query["id"]]["best_rank"]
        qwen_rank = qwen_by_id[query["id"]]["best_rank"]
        if e5_rank != qwen_rank:
            differences.append(
                {
                    "id": query["id"],
                    "query": query["query"],
                    "e5_best_rank": e5_rank,
                    "qwen_best_rank": qwen_rank,
                }
            )

    print(f"RANK_DISAGREEMENTS={len(differences)}")
    for item in sorted(
        differences,
        key=lambda value: abs(value["e5_best_rank"] - value["qwen_best_rank"]),
        reverse=True,
    )[:20]:
        print(
            "DISAGREEMENT="
            + json.dumps(item, separators=(",", ":"))
        )

    winner = "tie"
    e5_tuple = (
        e5_result["recall_at_1"],
        e5_result["mrr"],
        e5_result["ndcg_at_10"],
    )
    qwen_tuple = (
        qwen_result["recall_at_1"],
        qwen_result["mrr"],
        qwen_result["ndcg_at_10"],
    )
    if qwen_tuple > e5_tuple:
        winner = "qwen"
    elif e5_tuple > qwen_tuple:
        winner = "e5"

    print(f"QUALITY_RESULT={winner}")
    print(f"REPORT={report_path}")
    print("PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR={type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise
