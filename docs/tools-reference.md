# MCP Tools Reference

Sidekick registers built-in tools from `TOOL_DEFS` in `src/tools.js` and maps them to Zod schemas in `src/index.js`. All built-in tools return MCP content arrays with text payloads. Many tools also set `isError: true` when validation or execution fails.

## Complete Tool Table

| Tool | Category | Description | Arguments | Implementation Notes |
|---|---|---|---|---|
| `sidekick_bash` | Core Operations | Execute a shell command on the remote machine. | `command` | Blocks several destructive command patterns before execution. Output is redacted before return/logging. |
| `sidekick_read` | Core Operations | Read a UTF-8 text file from the remote filesystem. | `path` | Returns an error if the file does not exist. Content is redacted. |
| `sidekick_write` | Core Operations | Write UTF-8 content to a file on the remote machine. | `path, content` | Creates parent directories recursively before writing. |
| `sidekick_list` | Core Operations | List files and directories with type, size, modified time, and name. | `path` | Defaults to a server path through the MCP schema when omitted. |
| `sidekick_search` | Core Operations | Search file contents using ripgrep when available, falling back to grep. | `pattern, path optional, include optional` | Limits results and emits raw ripgrep JSON when ripgrep is used. |
| `sidekick_git` | Core Operations | Run structured git operations in a repository. | `action, path optional, args optional` | Allowed actions: status, diff, log, add, commit, push, pull, branch, checkout, stash. |
| `sidekick_store` | Storage and Context | Store a persistent key-value entry with optional project metadata. | `key, value, project optional` | Project names must match lowercase snake-style identifiers. |
| `sidekick_get` | Storage and Context | Retrieve a value from persistent KV storage. | `key` | Returns only the entry value, not the surrounding metadata. |
| `sidekick_list_projects` | Storage and Context | List unique project names present in KV storage. | `none` | Returns a JSON array. |
| `sidekick_get_by_project` | Storage and Context | Return all KV entries belonging to one project. | `project` | Returns a JSON array of key/value pairs. |
| `sidekick_context` | Storage and Context | Track and recall project context, decisions, problems, reusable patterns, and session summaries. | `action plus context fields` | Actions: track_project, track_decision, track_problem, track_pattern, track_session, recall, suggest, summarize, list. |
| `sidekick_teach` | Storage and Context | Create reusable procedures and dynamically expose them as MCP tools after restart. | `action, name, description, steps, parameters, args, example, trigger_phrases, implementation` | Actions: teach_procedure, generate_tool, learn_from_example, execute, list, remove. |
| `sidekick_web_fetch` | Web and Communication | Fetch a URL from the remote host with optional method, headers, and body. | `url, method optional, headers optional, body optional` | Supports GET and POST at the MCP schema level. |
| `sidekick_llm` | Web and Communication | Send a prompt to Groq if configured, otherwise Ollama. | `prompt, system optional, temperature optional` | The local fallback targets Ollama on 127.0.0.1:11434 and uses phi3:mini. |
| `sidekick_notify` | Web and Communication | Send notifications to Discord, Slack, or email. | `channel, webhook_url, recipient, message, title` | Discord and Slack use incoming webhooks. Email path expects SMTP environment variables but uses an HTTP-style request implementation. |
| `sidekick_github` | Web and Communication | Use the GitHub REST API for pull requests, issues, commit statuses, releases, and repository information. | `action, repo, args optional` | Reads the GitHub token from KV key github_token. |
| `sidekick_webhook` | Web and Communication | List, inspect, or clear webhook payloads received by the dashboard webhook endpoint. | `action, id optional, limit optional` | Actions: list, get, clear. |
| `sidekick_process` | Remote Management | List processes, display top CPU processes, kill by pid/name, or show process tree. | `action, filter, pid, name, signal` | Actions: list, top, kill, tree. |
| `sidekick_service` | Remote Management | Control or inspect systemd services. | `action, service, lines` | Actions: start, stop, restart, status, enable, disable, logs. Service actions use sudo systemctl; logs use journalctl. |
| `sidekick_archive` | Remote Management | Create, extract, or list tar.gz/tgz/zip archives. | `action, path, output, format` | Extraction runs in the current process working directory; output is required for create. |
| `sidekick_cron` | Automation | Add, list, remove, or manually run recurring cron jobs. | `action, name, schedule, command, id` | Stores metadata in cron.json and syncs enabled entries to the user's crontab. |
| `sidekick_delay` | Automation | Schedule a one-shot tool call for a future time. | `action, id, when, name, tool, args` | Actions: add, list, cancel, run. Supports relative strings such as 10s, 5m, 2h, 1d, or an ISO date. |
| `sidekick_watch` | Automation | Monitor a service, process, endpoint, or file and trigger another Sidekick tool when a condition is met. | `action, id, name, source, target, condition, interval, action_tool, action_args, pause` | Conditions include status checks, process running checks, endpoint status checks, file existence, and file content matching. |
| `sidekick_queue` | Automation | Manage a persistent priority queue of Sidekick tool calls. | `action, id, tool, args, priority, status` | Actions: add, list, process, remove, clear. Higher priority values are processed first. |
| `sidekick_retry` | Automation | Retry a tool call with fixed, linear, or exponential backoff. | `tool, args, max_attempts, backoff, initial_delay` | Default behavior is three attempts with exponential backoff. |
| `sidekick_health` | Observability | Run composite system health checks and produce a scored report. | `check, services, commands, threshold` | Checks: all, services, processes, disk, network, custom. Results are appended to health_history.json. |
| `sidekick_snapshot` | Observability | Capture system state and compare snapshots for drift. | `action, name, capture, compare` | Captures processes, services, disk, packages, network, and selected file/directory listings. |
| `sidekick_secret` | Security | Store, retrieve, rotate, delete, or list encrypted secrets. | `action, key, value, generate` | Uses AES-256-GCM and requires SIDEKICK_SECRET_KEY. |
| `sidekick_parse` | Data Utilities | Parse JSON, YAML, XML, INI, or CSV input with optional auto-detection. | `input, format optional` | Returns normalized JSON text. |
| `sidekick_transform` | Data Utilities | Filter, extract, sort, format, or map text/JSON data. | `action, input, pattern, format, field, key, value` | Actions: filter, extract, sort, format, map. |
| `sidekick_diff` | Data Utilities | Compare old and new text, JSON, or YAML. | `old_text, new_text, type, format` | Output formats: unified, summary, json. |
| `sidekick_hash` | Data Utilities | Hash a string or file and optionally verify against an expected digest. | `input, path, algorithm, verify` | Algorithms: md5, sha1, sha256, sha512. |
| `sidekick_validate` | Data Utilities | Validate data against JSON Schema using AJV. | `data, schema` | Accepts JSON strings or objects for both data and schema. |
| `sidekick_template` | Data Utilities | Render Handlebars templates using supplied data. | `template, data` | Template data may be a JSON string or object. |
| `sidekick_evolve` | Advanced Intelligence | Analyze usage patterns and maintain proposed system improvements with safety gates. | `action, id, proposal, approve, test` | Actions: analyze, propose, list, test, approve, reject. Proposals are rate-limited in code. |
| `sidekick_orchestrate` | Advanced Intelligence | Create and execute multi-step task graphs with dependency tracking. | `action, id, task_name, subtasks, dependencies, timeout` | Actions: create, execute, list, status, cancel. |
| `sidekick_predict` | Advanced Intelligence | Analyze stored context and tool logs to generate predictions and collect feedback. | `action, id, feedback` | Actions: analyze, list, feedback, suggest. |
| `sidekick_anonymize` | Security | Replace sensitive data with realistic fake values. Consistent mapping, custom patterns, redact safety net. | `action, input, format, custom_patterns, consistency` | Actions: anonymize, patterns, add_pattern, remove_pattern. Built-in patterns for IPs, emails, UUIDs, paths, hostnames. |
| `sidekick_sandbox` | Safety | Execute operations with automatic file backup and rollback. Safe experimentation on remote systems. | `action, sandbox_name, command, files, auto_backup, rollback_id` | Actions: exec, rollback, list, diff, clean. Backs up files before execution, supports rollback. |
| `sidekick_changelog` | Development | Generate release notes from git history. Groups by type/scope/author, optional LLM summaries. | `action, from, to, format, group_by, use_llm, include, path` | Actions: generate, preview, save. Parses conventional commits, groups semantically. |
| `sidekick_netdiag` | Diagnostics | Unified network diagnostics: DNS, routing, port scanning, connectivity checks, local listeners. | `action, target, port_range, timeout, format` | Actions: check, dns, route, ports, listeners, connectivity. Replaces multiple network commands. |
| `sidekick_timeline` | Observability | Build chronological timelines from multiple sources (log.jsonl, journalctl, git, files). | `action, since, until, sources, pattern, severity, format, max_events` | Actions: build, filter, export. Correlates events across sources chronologically. |
| `sidekick_circuit` | Reliability | Generic circuit breaker for any tool call. Fast-fail when targets are down, configurable thresholds. | `action, target, tool, args, failure_threshold, cooldown_seconds, cache_response` | Actions: call, status, reset, configure. Prevents cascading failures. |
| `sidekick_baseline` | Observability | Behavioral baseline and anomaly detection. Learns patterns, detects statistical deviations. | `action, metric_name, value, source, command, window, sensitivity` | Actions: record, learn, check, status, reset. Time-of-day bucketing, statistical analysis. |
| `sidekick_depend` | Analysis | Dependency analyzer for npm, systemd services, processes. Trees, reverse deps, impact analysis. | `action, type, target, depth, format` | Actions: tree, reverse, outdated, impact, orphans. Shows dependency relationships and blast radius. |
| `sidekick_runbook` | Operations | Operational runbook executor with autonomous and guided modes. Verification, rollback, step-by-step. | `action, name, mode, steps, runbook_id, step_index` | Actions: create, start, next, verify, rollback, abort, list, get, delete. Supports both autonomous and guided execution. |
| `sidekick_black_box` | Observability | Incident time capsule capturing full system context. Rate limited (5/day, 7-day TTL, 3 active max). | `action, name, include, analyze_with_llm, incident_id` | Actions: capture, list, get, delete, analyze. Captures services, processes, logs, disk, network in one call. |

## Core Operation Tools

### `sidekick_bash`

Executes a shell command with a 60-second timeout and a 10 MB output buffer. Before execution, commands are checked against destructive patterns such as `rm -rf /`, disk formatting commands, direct writes to block devices, fork bombs, curl/wget piped into shell, and recursive `chmod 777 /`.

Use this for Linux command execution when a specialized tool is not available. Prefer specialized tools for git, services, process management, archives, and web requests because they validate inputs more narrowly.

### `sidekick_read`, `sidekick_write`, and `sidekick_list`

These provide direct filesystem access. `sidekick_write` creates parent directories before writing. `sidekick_list` reports item type, size, modified timestamp, and name.

### `sidekick_search`

Searches with `rg --json --max-count 100` when ripgrep exists. If ripgrep is unavailable, it falls back to grep with recursive search and maximum count. The optional `include` argument is passed as a file glob.

### `sidekick_git`

Wraps selected git actions with `git -C <repo> <action>`. The `args` string is split on whitespace and appended. This keeps the primary action constrained but does not fully parse shell-style quoting.

## Storage and Memory Tools

### KV Store

`sidekick_store`, `sidekick_get`, `sidekick_list_projects`, and `sidekick_get_by_project` operate on `kvstore.json`.

New-format KV entries use this structure:

```json
{
  "value": "stored text",
  "project": "project_name_or_null",
  "source": "mcp|agent|dashboard|unknown",
  "created": "ISO timestamp",
  "updated": "ISO timestamp"
}
```

Legacy string entries are migrated at startup by `migrateKV()`.

### Context Store

`sidekick_context` stores structured project context in `context.json`. It tracks:

- Projects.
- Decisions.
- Problems and solutions.
- Workflow patterns.
- Session summaries.

Recall and suggestion operations use simple word-set similarity rather than embeddings.

### Teach and Procedures

`sidekick_teach` stores learned procedures in `procedures.json`. Procedures can be executed directly through `sidekick_teach` or exposed as dynamic MCP tools after server restart.

A procedure step is a tool call:

```json
{
  "tool": "sidekick_bash",
  "args": { "command": "uptime" }
}
```

Parameter definitions support `string`, `number`, and `boolean` types.

## Automation Tools

### `sidekick_cron`

Stores cron job metadata in `cron.json` and syncs enabled jobs to the user's crontab. Generated crontab lines run from `/home/sidekick/sidekick` and redirect output to `cron-<id>.log` under `SIDEKICK_DATA_DIR`.

### `sidekick_delay`

Stores one-shot scheduled tool calls in `delays.json`. The agent bridge loads pending delays on startup and schedules them in memory. If the agent bridge is not running, pending delays will not execute until it starts and reloads them.

### `sidekick_watch`

Stores monitoring rules in `watches.json`. The agent bridge loads active watches and checks them on intervals. Supported sources are service, process, endpoint, and file. Watches can call another Sidekick tool when triggered and support message template replacements such as `{source}`, `{target}`, `{status}`, and `{time}`.

### `sidekick_queue` and `sidekick_retry`

The queue stores pending tool calls with priority and status. The retry tool wraps `callTool()` and retries failed results with configurable backoff.

## Observability Tools

`sidekick_health` checks services, processes, disk, network, or custom commands and produces a Markdown report. `sidekick_snapshot` captures state and supports drift comparison. `sidekick_predict` analyzes context and tool logs to identify patterns.

## Security and Credentials Tools

`sidekick_secret` encrypts secrets with AES-256-GCM into `secrets.enc`. It requires `SIDEKICK_SECRET_KEY`. `sidekick_github` does not use `sidekick_secret`; it reads a token from the KV key `github_token`.

## Data Utility Tools

The parsing, transformation, diff, hash, validation, and template tools provide local data manipulation for agent workflows. They avoid needing ad hoc shell pipelines for common structured data tasks.
