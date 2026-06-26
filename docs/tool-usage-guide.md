# Tool Usage Guide

This guide explains how to choose tools in normal work. For exact arguments, see `tools-reference.md`.

## Core remote work

Use these first when the assistant needs to inspect or modify the remote host:

- `sidekick_bash`: execute shell commands. Best for short, targeted commands with predictable output.
- `sidekick_read`: read one UTF-8 file.
- `sidekick_write`: write text content to one file.
- `sidekick_list`: inspect a directory.
- `sidekick_search`: search file contents with ripgrep or grep.
- `sidekick_git`: run constrained git operations.

Prefer `sidekick_search`, `sidekick_summarize`, `sidekick_filter`, `sidekick_find`, and `sidekick_project` over large `cat` outputs when token usage matters.

## Persistent memory

Recall project context at the start of work that may depend on prior decisions. Use `sidekick_project name="<project>"` for a broad project brief, or `sidekick_context action="recall" project="<project>" query="<topic>"` for a focused search. Always recall before deployment, incident response, credential or access work, PR/merge/release decisions, database migrations, destructive cleanup, and any task where the user mentions earlier work.

Check project handoffs at session startup with `sidekick_resume action="check" project="<project>"`. Use `sidekick_resume action="set"` when leaving unfinished work, and `sidekick_resume action="clear"` once the handoff is complete. This replaces ad hoc resume pointers in KV storage.

Use `sidekick_store` for durable facts that should survive sessions. Use project names that match `^[a-z][a-z0-9_]*$`. Good project names are lowercase and specific, such as `sidekick`, `jellyfin`, `proxmox_lab`, or `website_redesign`.

Use `sidekick_context` for richer history:

- `track_project` for project descriptions;
- `track_decision` for decisions and reasoning;
- `track_problem` for issues and resolutions;
- `track_pattern` for reusable patterns;
- `track_session` for session summaries;
- `recall`, `suggest`, and `summarize` to retrieve prior context.

Store durable memory when a future agent would make a better or safer decision from the information. Use `track_decision` for policies, preferences, PR/merge rules, architecture choices, and rationale. Use `track_problem` for incidents, root causes, failed approaches, and fixes. Use `track_pattern` for reusable workflows. Use `track_session` for meaningful end-of-task summaries. Use `sidekick_store` when an exact lookup key is useful, such as hostnames, paths, feature flags, or named operational notes.

Do not store raw secrets, tokens, private keys, passwords, or full sensitive outputs in KV, context, knowledge, or memories. Use `sidekick_secret` for credentials. Do not store transient status, command noise, or facts that are obvious from the current repository. If a note is sensitive but operationally useful, store only the minimum redacted instruction needed for future safety.

The Agent Bridge automatically records bounded, redacted memory summaries for completed autonomous tasks and memory-worthy tool calls. It also extracts simple `fact`, `decision`, `preference`, and `open_thread` memories when task text is explicit enough. These automatic memories are stored primarily in the `memories` table, with compatibility copies in the `context` document, capped by `SIDEKICK_AUTO_MEMORY_MAX` and disabled with `SIDEKICK_AUTO_MEMORY=0`. Semantic recall uses Ollama embeddings and Qdrant when available, and can be disabled with `SIDEKICK_EMBEDDINGS=0`. They are meant for continuity, not as complete raw transcripts.

Use `sidekick_memory_export` and `sidekick_memory_import` for portable JSON backups, `sidekick_memory_manage` for confirmation/delete/expire/restore workflows, and the `sidekick_sync_*` tools for cross-machine memory synchronization.

## Automation

Use `sidekick_delay` for one-shot future actions. The Agent Bridge loads pending delays at startup and executes them at the scheduled time.

Use `sidekick_watch` for recurring checks against services, processes, endpoints, or files. A watch can call another tool when its condition triggers.

Use `sidekick_cron` for real system cron entries when a job should survive outside the Node.js timer process.

Use `sidekick_queue`, `sidekick_retry`, `sidekick_batch`, and `sidekick_orchestrate` to reduce repeated planning overhead and handle multi-step execution.

## Operations and diagnostics

Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_netdiag` for DNS, routes, ports, listeners, and connectivity checks. Use `sidekick_black_box` during incidents to capture a time-limited bundle of current system state.

## Safe experimentation

Use `sidekick_sandbox` when a command may change files and you want automatic backup and rollback support. Use `sidekick_snapshot` before and after operational changes to compare system state.

## Data manipulation

Use `sidekick_parse`, `sidekick_extract`, `sidekick_transform`, `sidekick_validate`, `sidekick_template`, `sidekick_hash`, and `sidekick_diff` when working with structured or semi-structured data.

## LLM tools

Use `sidekick_llm` for direct model calls. Use `sidekick_fresheyes` when the main assistant wants an independent second look at a problem using Sidekick's configured LLM.

## Self-extension

Use `sidekick_teach` to define reusable procedures. Use `sidekick_evolve` only with care: it is designed for analyzing, proposing, testing, and approving self-modification-style changes.
