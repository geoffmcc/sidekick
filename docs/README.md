# Sidekick Documentation

Sidekick is a self-hosted MCP server and autonomous assistant platform designed to act as an operational assistant for opencode. It exposes a large set of tools for remote command execution, file operations, persistent memory, service management, GitHub automation, scheduling, monitoring, data processing, and self-extension.

This documentation set was generated from the project source code in the supplied `sidekick-main.zip` archive. It focuses on the behavior implemented in the codebase, not only the public README.

## Documentation Map

| Document | Purpose |
|---|---|
| `architecture.md` | System architecture, service boundaries, request flow, sessions, and runtime layout. |
| `installation.md` | Installation, deployment, service startup, and opencode integration. |
| `configuration.md` | Environment variables, ports, data directory, LLM configuration, and authentication settings. |
| `tools-reference.md` | Complete MCP tool catalog and implementation notes. |
| `dashboard.md` | Dashboard UI, API routes, proxy behavior, webhook storage, and data reset endpoints. |
| `agent-bridge.md` | Autonomous agent loop, task streaming, transcript storage, and procedure suggestion behavior. |
| `data-model.md` | Persistent files, JSON structures, KV migration, logs, snapshots, secrets, and conversations. |
| `security.md` | Authentication, IP filtering, rate limiting, CSRF checks, command safety, redaction, and secret handling. |
| `operations.md` | Runtime checks, service operations, logs, troubleshooting, backups, and maintenance. |
| `development.md` | Project structure, code organization, tests, extension workflow, and known implementation notes. |
| `api-reference.md` | HTTP endpoint reference for MCP, dashboard, and agent bridge services. |

## Services

| Service | Default Port | Entry Point | Purpose |
|---|---:|---|---|
| MCP Server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP streamable HTTP and legacy SSE. |
| Dashboard | 4098 | `src/dashboard.js` | Browser UI and management API for logs, KV data, services, webhooks, and agent tasks. |
| Agent Bridge | 4099 | `src/agent.js` | Local-only autonomous task runner that plans and executes Sidekick tool calls. |
| Ollama | 11434 | external service | Optional local LLM fallback when Groq is not configured. |

## Tool Inventory

| Tool | Category | Summary | Arguments |
|---|---|---|---|
| `sidekick_bash` | Core Operations | Execute a shell command on the remote machine. | `command` |
| `sidekick_read` | Core Operations | Read a UTF-8 text file from the remote filesystem. | `path` |
| `sidekick_write` | Core Operations | Write UTF-8 content to a file on the remote machine. | `path, content` |
| `sidekick_list` | Core Operations | List files and directories with type, size, modified time, and name. | `path` |
| `sidekick_search` | Core Operations | Search file contents using ripgrep when available, falling back to grep. | `pattern, path optional, include optional` |
| `sidekick_git` | Core Operations | Run structured git operations in a repository. | `action, path optional, args optional` |
| `sidekick_store` | Storage and Context | Store a persistent key-value entry with optional project metadata. | `key, value, project optional` |
| `sidekick_get` | Storage and Context | Retrieve a value from persistent KV storage. | `key` |
| `sidekick_list_projects` | Storage and Context | List unique project names present in KV storage. | `none` |
| `sidekick_get_by_project` | Storage and Context | Return all KV entries belonging to one project. | `project` |
| `sidekick_context` | Storage and Context | Track and recall project context, decisions, problems, reusable patterns, and session summaries. | `action plus context fields` |
| `sidekick_teach` | Storage and Context | Create reusable procedures and dynamically expose them as MCP tools after restart. | `action, name, description, steps, parameters, args, example, trigger_phrases, implementation` |
| `sidekick_web_fetch` | Web and Communication | Fetch a URL from the remote host with optional method, headers, and body. | `url, method optional, headers optional, body optional` |
| `sidekick_llm` | Web and Communication | Send a prompt to the LLM. Defaults to local Ollama, use `provider='groq'` for cloud Groq. | `prompt, system optional, temperature optional, provider optional` |
| `sidekick_notify` | Web and Communication | Send notifications to Discord, Slack, or email. | `channel, webhook_url, recipient, message, title` |
| `sidekick_github` | Web and Communication | Use the GitHub REST API for pull requests, issues, commit statuses, releases, and repository information. | `action, repo, args optional` |
| `sidekick_webhook` | Web and Communication | List, inspect, or clear webhook payloads received by the dashboard webhook endpoint. | `action, id optional, limit optional` |
| `sidekick_process` | Remote Management | List processes, display top CPU processes, kill by pid/name, or show process tree. | `action, filter, pid, name, signal` |
| `sidekick_service` | Remote Management | Control or inspect systemd services. | `action, service, lines` |
| `sidekick_archive` | Remote Management | Create, extract, or list tar.gz/tgz/zip archives. | `action, path, output, format` |
| `sidekick_cron` | Automation | Add, list, remove, or manually run recurring cron jobs. | `action, name, schedule, command, id` |
| `sidekick_delay` | Automation | Schedule a one-shot tool call for a future time. | `action, id, when, name, tool, args` |
| `sidekick_watch` | Automation | Monitor a service, process, endpoint, or file and trigger another Sidekick tool when a condition is met. | `action, id, name, source, target, condition, interval, action_tool, action_args, pause` |
| `sidekick_queue` | Automation | Manage a persistent priority queue of Sidekick tool calls. | `action, id, tool, args, priority, status` |
| `sidekick_retry` | Automation | Retry a tool call with fixed, linear, or exponential backoff. | `tool, args, max_attempts, backoff, initial_delay` |
| `sidekick_health` | Observability | Run composite system health checks and produce a scored report. | `check, services, commands, threshold` |
| `sidekick_snapshot` | Observability | Capture system state and compare snapshots for drift. | `action, name, capture, compare` |
| `sidekick_secret` | Security | Store, retrieve, rotate, delete, or list encrypted secrets. | `action, key, value, generate` |
| `sidekick_parse` | Data Utilities | Parse JSON, YAML, XML, INI, or CSV input with optional auto-detection. | `input, format optional` |
| `sidekick_transform` | Data Utilities | Filter, extract, sort, format, or map text/JSON data. | `action, input, pattern, format, field, key, value` |
| `sidekick_diff` | Data Utilities | Compare old and new text, JSON, or YAML. | `old_text, new_text, type, format` |
| `sidekick_hash` | Data Utilities | Hash a string or file and optionally verify against an expected digest. | `input, path, algorithm, verify` |
| `sidekick_validate` | Data Utilities | Validate data against JSON Schema using AJV. | `data, schema` |
| `sidekick_template` | Data Utilities | Render Handlebars templates using supplied data. | `template, data` |
| `sidekick_evolve` | Advanced Intelligence | Analyze usage patterns and maintain proposed system improvements with safety gates. | `action, id, proposal, approve, test` |
| `sidekick_orchestrate` | Advanced Intelligence | Create and execute multi-step task graphs with dependency tracking. | `action, id, task_name, subtasks, dependencies, timeout` |
| `sidekick_predict` | Advanced Intelligence | Analyze stored context and tool logs to generate predictions and collect feedback. | `action, id, feedback` |
| `sidekick_anonymize` | Security | Replace sensitive data with realistic fake values. Consistent mapping, custom patterns, redact safety net. | `action, input, format, custom_patterns, consistency` |
| `sidekick_sandbox` | Safety | Execute operations with automatic file backup and rollback. Safe experimentation on remote systems. | `action, sandbox_name, command, files, auto_backup, rollback_id` |
| `sidekick_changelog` | Development | Generate release notes from git history. Groups by type/scope/author, optional LLM summaries. | `action, from, to, format, group_by, use_llm, include, path` |
| `sidekick_netdiag` | Diagnostics | Unified network diagnostics: DNS, routing, port scanning, connectivity checks, local listeners. | `action, target, port_range, timeout, format` |
| `sidekick_timeline` | Observability | Build chronological timelines from multiple sources (log.jsonl, journalctl, git, files). | `action, since, until, sources, pattern, severity, format, max_events` |
| `sidekick_circuit` | Reliability | Generic circuit breaker for any tool call. Fast-fail when targets are down, configurable thresholds. | `action, target, tool, args, failure_threshold, cooldown_seconds, cache_response` |
| `sidekick_baseline` | Observability | Behavioral baseline and anomaly detection. Learns patterns, detects statistical deviations. | `action, metric_name, value, source, command, window, sensitivity` |
| `sidekick_depend` | Analysis | Dependency analyzer for npm, systemd services, processes. Trees, reverse deps, impact analysis. | `action, type, target, depth, format` |
| `sidekick_runbook` | Operations | Operational runbook executor with autonomous and guided modes. Verification, rollback, step-by-step. | `action, name, mode, steps, runbook_id, step_index` |
| `sidekick_black_box` | Observability | Incident time capsule capturing full system context. Rate limited (5/day, 7-day TTL, 3 active max). | `action, name, include, analyze_with_llm, incident_id` |

## Key Concepts

Sidekick has three major operating modes:

1. `opencode` uses the MCP server directly through the Sidekick tool set.
2. The dashboard provides a web interface for observing and managing Sidekick state.
3. The agent bridge accepts a task goal, loops with an LLM, calls tools, streams status events, and writes a conversation transcript.

The persistent data model is file-based. Most state is stored as JSON under `SIDEKICK_DATA_DIR`, with append-only JSONL logs for tool calls and audit events. This makes the system easy to inspect, back up, and repair manually.
