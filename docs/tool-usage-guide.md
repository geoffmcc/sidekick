# Tool Usage Guide

This guide explains how to choose tools in normal work. For exact arguments, see `tools-reference.md`.

Tool names below are the canonical unprefixed MCP names (`bash`, `store`, `context`, …). Older `sidekick_`-prefixed spellings still resolve as compatibility aliases.

## Core remote work

Use these first when the assistant needs to inspect or modify the remote host:

- `bash`: execute shell commands. Best for short, targeted commands with predictable output.
- `read`: read one UTF-8 file.
- `write`: write text content to one file.
- `list`: inspect a directory.
- `search`: search file contents with ripgrep or grep.
- `git`: run constrained git operations.

Prefer `search`, `summarize`, `filter`, `find`, and `project` over large `cat` outputs when token usage matters.

## Persistent memory

Recall project context at the start of work that may depend on prior decisions. Use `project name="<project>"` for a broad project brief, or `context action="recall" project="<project>" query="<topic>"` for a focused search. Always recall before deployment, incident response, credential or access work, PR/merge/release decisions, database migrations, destructive cleanup, and any task where the user mentions earlier work.

Check project handoffs at session startup with `resume action="check" project="<project>"`. Use `resume action="set"` when leaving unfinished work, and `resume action="clear"` once the handoff is complete. This replaces ad hoc resume pointers in KV storage.

Use `store` for durable facts that should survive sessions. Use project names that match `^[a-z][a-z0-9_]*$`. Good project names are lowercase and specific, such as `sidekick`, `jellyfin`, `proxmox_lab`, or `website_redesign`.

Use `context` for richer history:

- `track_project` for project descriptions;
- `track_decision` for decisions and reasoning;
- `track_problem` for issues and resolutions;
- `track_pattern` for reusable patterns;
- `track_session` for session summaries;
- `recall`, `suggest`, and `summarize` to retrieve prior context.

Store durable memory when a future agent would make a better or safer decision from the information. Use `track_decision` for policies, preferences, PR/merge rules, architecture choices, and rationale. Use `track_problem` for incidents, root causes, failed approaches, and fixes. Use `track_pattern` for reusable workflows. Use `track_session` for meaningful end-of-task summaries. Use `store` when an exact lookup key is useful, such as hostnames, paths, feature flags, or named operational notes.

Do not store raw secrets, tokens, private keys, passwords, or full sensitive outputs in KV, context, knowledge, or memories. Use `secret` for credentials. Do not store transient status, command noise, or facts that are obvious from the current repository. If a note is sensitive but operationally useful, store only the minimum redacted instruction needed for future safety.

The Agent Bridge automatically records bounded, redacted memory summaries for completed autonomous tasks and memory-worthy tool calls. It also extracts simple `fact`, `decision`, `preference`, and `open_thread` memories when task text is explicit enough. These automatic memories are stored primarily in the `memories` table, with compatibility copies in the `context` document, capped by `SIDEKICK_AUTO_MEMORY_MAX` and disabled with `SIDEKICK_AUTO_MEMORY=0`. Semantic recall uses Ollama embeddings and Qdrant when available, and can be disabled with `SIDEKICK_EMBEDDINGS=0`. They are meant for continuity, not as complete raw transcripts.

Use `memory_export` and `memory_import` for portable JSON backups, `memory_manage` for confirmation/delete/expire/restore workflows, and the `sync_*` tools for cross-machine memory synchronization.

## Automation

Use `delay` for one-shot future actions. The Agent Bridge loads pending delays at startup and executes them at the scheduled time.

Use `watch` for recurring checks against services, processes, endpoints, or files. A watch can call another tool when its condition triggers.

Use `cron` for real system cron entries when a job should survive outside the Node.js timer process.

Use `queue`, `retry`, `batch`, and `orchestrate` to reduce repeated planning overhead and handle multi-step execution.

## Operations and diagnostics

Use `status` for a compact system overview. Use `health` for a scored health check. Use `tail` for recent logs. Use `netdiag` for DNS, routes, ports, listeners, and connectivity checks. Use `black_box` during incidents to capture a time-limited bundle of current system state.

## Safe experimentation

Use `sandbox` when a command may change files and you want automatic backup and rollback support. Use `snapshot` before and after operational changes to compare system state.

## Data manipulation

Use `parse`, `extract`, `transform`, `validate`, `template`, `hash`, and `diff` when working with structured or semi-structured data.

## LLM tools

Use `llm` for direct model calls. Use `fresheyes` when the main assistant wants an independent second look at a problem using Sidekick's configured LLM.

## Self-extension

Use `teach` to define reusable procedures composed from existing tools. Use `evolve` only with care: it mines repeated successful workflows, validates parameterized procedures, and manages explicit trial/active generated-tool lifecycle states.
