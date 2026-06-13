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

Use `sidekick_store` for durable facts that should survive sessions. Use project names that match `^[a-z][a-z0-9_]*$`. Good project names are lowercase and specific, such as `sidekick`, `jellyfin`, `proxmox_lab`, or `website_redesign`.

Use `sidekick_context` for richer history:

- `track_project` for project descriptions;
- `track_decision` for decisions and reasoning;
- `track_problem` for issues and resolutions;
- `track_pattern` for reusable patterns;
- `track_session` for session summaries;
- `recall`, `suggest`, and `summarize` to retrieve prior context.

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
