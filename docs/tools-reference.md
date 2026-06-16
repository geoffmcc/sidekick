# Tools Reference

This catalog is generated from `TOOL_DEFS` in `src/tools.js`. The current code exports 83 built-in tool handlers. Most tools return MCP content blocks containing text. Errors usually set `isError: true` and include an explanatory text result.

Tool definitions exposed by the dashboard API include policy metadata:

- `risk`: `low`, `medium`, `high`, or `critical`
- `enabled`: whether the active source policy allows the tool
- `policy`: short reason for the policy decision

## Risk classification

Risk is based on what a tool can change or expose, not whether its implementation is currently safe.

| Risk | Tools | Default recommendation |
|---|---|---|
| Critical | `sidekick_bash`, `sidekick_write`, `sidekick_db_restore`, `sidekick_runbook`, `sidekick_sandbox`, `sidekick_evolve` | Gate in shared or public deployments. Allow only for trusted operators. |
| High | `sidekick_process`, `sidekick_service`, `sidekick_cron`, `sidekick_delay`, `sidekick_watch`, `sidekick_github`, `sidekick_teach`, `sidekick_secret`, `sidekick_db_migrate`, `sidekick_queue`, `sidekick_orchestrate`, `sidekick_wireguard`, `sidekick_nginx` | Block in `restricted` mode unless the workflow needs them. |
| Medium | `sidekick_notify`, `sidekick_read`, `sidekick_archive`, `sidekick_git`, `sidekick_web_fetch`, `sidekick_llm`, `sidekick_context`, `sidekick_health`, `sidekick_snapshot`, `sidekick_retry`, `sidekick_fresheyes`, `sidekick_batch`, `sidekick_tail`, `sidekick_find`, `sidekick_status`, `sidekick_extract`, `sidekick_changelog`, `sidekick_netdiag`, `sidekick_timeline`, `sidekick_circuit`, `sidekick_baseline`, `sidekick_depend`, `sidekick_black_box`, `sidekick_db_query`, `sidekick_db_backup`, `sidekick_db_export`, `sidekick_redis`, `sidekick_tunnel` | Generally useful, but can expose data or trigger external effects. |
| Low | `sidekick_list`, `sidekick_store`, `sidekick_get`, `sidekick_list_projects`, `sidekick_get_by_project`, `sidekick_search`, `sidekick_webhook`, `sidekick_transform`, `sidekick_parse`, `sidekick_diff`, `sidekick_hash`, `sidekick_validate`, `sidekick_template`, `sidekick_predict`, `sidekick_debug_tool`, `sidekick_cache`, `sidekick_summarize`, `sidekick_filter`, `sidekick_project`, `sidekick_diff_files`, `sidekick_anonymize`, `sidekick_respond`, `sidekick_db_schema`, `sidekick_db_stats`, `sidekick_log_query`, `sidekick_db_search`, `sidekick_db_diff`, `sidekick_ocr`, `sidekick_media`, `sidekick_transcribe`, `sidekick_analytics`, `sidekick_embed`, `sidekick_ollama`, `sidekick_download`, `sidekick_knowledge`, `sidekick_metrics` | Usually safe to expose, subject to data sensitivity. |

Use `SIDEKICK_TOOL_POLICY=restricted` to block high and critical tools by default. Use `SIDEKICK_ALLOWED_TOOLS`, `SIDEKICK_BLOCKED_TOOLS`, and source-specific variants such as `SIDEKICK_AGENT_ALLOWED_TOOLS` for deployment-specific control.

## Full inventory

| Tool | Category | Description | Argument summary |
|---|---|---|---|
| `sidekick_bash` | Core file, shell, and code operations | Execute a shell command on the remote machine | `{ command: "string" }` |
| `sidekick_read` | Core file, shell, and code operations | Read a file from the remote filesystem | `{ path: "string" }` |
| `sidekick_write` | Core file, shell, and code operations | Write content to a file on the remote machine | `{ path: "string", content: "string" }` |
| `sidekick_list` | Core file, shell, and code operations | List files and directories on the remote machine | `{ path: "string" }` |
| `sidekick_store` | Persistent memory and project context | Store a value persistently in KV storage | `{ key: "string", value: "string", project: "string (optional)" }` |
| `sidekick_get` | Persistent memory and project context | Retrieve a stored value from KV storage | `{ key: "string" }` |
| `sidekick_web_fetch` | Core file, shell, and code operations | Fetch a URL from the remote machine | `{ url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" }` |
| `sidekick_llm` | AI, learning, and self-extension | Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq) | `{ prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" }` |
| `sidekick_list_projects` | Persistent memory and project context | List all unique project names in KV storage | `{}` |
| `sidekick_get_by_project` | Persistent memory and project context | Get all keys and values for a specific project | `{ project: "string" }` |
| `sidekick_search` | Core file, shell, and code operations | Search file contents using ripgrep or grep | `{ pattern: "string", path: "string (optional)", include: "string (optional)" }` |
| `sidekick_git` | Core file, shell, and code operations | Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash) | `{ action: "string", path: "string (optional)", args: "string (optional)" }` |
| `sidekick_notify` | External integrations and secrets | Send notifications to Discord, Slack, or email | `{ channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" }` |
| `sidekick_process` | Core file, shell, and code operations | Manage processes (list, top CPU/memory, kill, tree) | `{ action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" }` |
| `sidekick_service` | Core file, shell, and code operations | Manage systemd services (start, stop, restart, status, enable, disable, logs) | `{ action: "string", service: "string", lines: "number (optional)" }` |
| `sidekick_archive` | Core file, shell, and code operations | Create, extract, or list archives (tar.gz, zip) | `{ action: "string", path: "string", output: "string (optional)", format: "string (optional)" }` |
| `sidekick_cron` | Automation, scheduling, and orchestration | Schedule recurring tasks (add, list, remove, run jobs) | `{ action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" }` |
| `sidekick_github` | External integrations and secrets | GitHub API integration (PRs, issues, commits, releases) | `{ action: "string", repo: "string", args: "string (optional)" }` |
| `sidekick_webhook` | External integrations and secrets | Manage received webhooks (list, get, clear) | `{ action: "string", id: "string (optional)", limit: "number (optional)" }` |
| `sidekick_context` | Persistent memory and project context | Persistent intelligent context management (track projects, decisions, problems, patterns, sessions, automatic memories; recall and suggest based on past context) | `{ action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional: decisions|problems|patterns|projects|sessions|memories|all)", limit: "number (optional)" }` |
| `sidekick_teach` | AI, learning, and self-extension | Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows | `{ action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" }` |
| `sidekick_transform` | Data processing and document utilities | Data manipulation pipeline: filter, extract, sort, format, and map data | `{ action: "string (filter|extract|sort|format|map)", input: "string", pattern: "string (optional, for filter)", field: "string (optional, for extract)", key: "string (optional, for sort/map)", value: "string (optional, for map)", format: "string (optional, for format: json|csv|table|text)" }` |
| `sidekick_health` | Monitoring, diagnostics, and operations | Composite system health checks with scoring and issue detection | `{ check: "string (all|services|processes|disk|network|custom)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" }` |
| `sidekick_delay` | Automation, scheduling, and orchestration | One-shot task scheduling: run a tool once at a specific time or after a delay | `{ action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" }` |
| `sidekick_snapshot` | Monitoring, diagnostics, and operations | Capture system state and detect drift by comparing snapshots | `{ action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" }` |
| `sidekick_watch` | Automation, scheduling, and orchestration | Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions | `{ action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" }` |
| `sidekick_secret` | External integrations and secrets | Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env) | `{ action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" }` |
| `sidekick_parse` | Data processing and document utilities | Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection | `{ input: "string (data to parse)", format: "string (optional, json|yaml|xml|ini|csv - auto-detected if not specified)" }` |
| `sidekick_diff` | Data processing and document utilities | Semantic comparison of text, JSON, or YAML with structure-aware diffing | `{ old_text: "string (original content)", new_text: "string (modified content)", type: "string (optional, text|json|yaml|auto - default auto)", format: "string (optional, unified|summary|json - default unified)" }` |
| `sidekick_hash` | Data processing and document utilities | Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification | `{ input: "string (optional, data to hash)", path: "string (optional, file path to hash)", algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)", verify: "string (optional, expected hash to verify against)" }` |
| `sidekick_validate` | Data processing and document utilities | Validate data against JSON Schema | `{ data: "string|object (data to validate)", schema: "string|object (JSON Schema)" }` |
| `sidekick_template` | Data processing and document utilities | Render Handlebars templates with data | `{ template: "string (Handlebars template)", data: "string|object (template data)" }` |
| `sidekick_queue` | Automation, scheduling, and orchestration | Persistent task queue with priorities | `{ action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" }` |
| `sidekick_retry` | Automation, scheduling, and orchestration | Retry tool calls with exponential backoff | `{ tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" }` |
| `sidekick_evolve` | AI, learning, and self-extension | Self-modification with safety: analyze patterns, propose improvements, test and approve changes | `{ action: "string (analyze|propose|list|test|approve|reject)", id: "string (optional, proposal id for test/approve/reject)", proposal: "string (optional, proposal description for propose)", approve: "boolean (optional, deprecated - use action=approve)", test: "boolean (optional, deprecated - use action=test)" }` |
| `sidekick_orchestrate` | Automation, scheduling, and orchestration | Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress | `{ action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" }` |
| `sidekick_predict` | AI, learning, and self-extension | Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness | `{ action: "string (analyze|list|feedback|suggest)", id: "string (optional, prediction id for feedback)", feedback: "boolean (optional, true if useful, false if not)" }` |
| `sidekick_debug_tool` | Persistent memory and project context | Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries. | `{ action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" }` |
| `sidekick_fresheyes` | AI, learning, and self-extension | Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis | `{ problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" }` |
| `sidekick_batch` | Automation, scheduling, and orchestration | Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch. | `{ calls: "array (array of { tool: string, args: object })" }` |
| `sidekick_cache` | Data processing and document utilities | Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL. | `{ action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" }` |
| `sidekick_summarize` | Monitoring, diagnostics, and operations | Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats. | `{ path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" }` |
| `sidekick_filter` | Monitoring, diagnostics, and operations | Filter file contents or directory listings by pattern, date, or size before returning. | `{ path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" }` |
| `sidekick_project` | Persistent memory and project context | Get complete project context in one call: KV entries, context tracking, recent logs, procedures. | `{ name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" }` |
| `sidekick_tail` | Monitoring, diagnostics, and operations | Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file. | `{ source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" }` |
| `sidekick_diff_files` | Monitoring, diagnostics, and operations | Compare two files directly without reading both into context. Returns unified diff or summary. | `{ path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" }` |
| `sidekick_find` | Monitoring, diagnostics, and operations | Advanced file finder: search by name pattern, date range, size range, and content pattern. | `{ path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" }` |
| `sidekick_status` | Monitoring, diagnostics, and operations | Unified system status: services, disk, memory, load, uptime, top processes in one call. | `{ include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" }` |
| `sidekick_extract` | Data processing and document utilities | Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need. | `{ path: "string (file path)", fields: "string|array (optional, field paths to extract e.g. 'database.host,database.port')" }` |
| `sidekick_anonymize` | Data processing and document utilities | Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally. | `{ action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" }` |
| `sidekick_sandbox` | External integrations and secrets | Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems. | `{ action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" }` |
| `sidekick_changelog` | Data processing and document utilities | Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries. | `{ action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" }` |
| `sidekick_netdiag` | Monitoring, diagnostics, and operations | Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners. | `{ action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" }` |
| `sidekick_timeline` | Monitoring, diagnostics, and operations | Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications. | `{ action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" }` |
| `sidekick_circuit` | Automation, scheduling, and orchestration | Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down. | `{ action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" }` |
| `sidekick_baseline` | Monitoring, diagnostics, and operations | Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations. | `{ action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" }` |
| `sidekick_depend` | Monitoring, diagnostics, and operations | Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis. | `{ action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" }` |
| `sidekick_runbook` | Automation, scheduling, and orchestration | Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution. | `{ action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" }` |
| `sidekick_black_box` | Monitoring, diagnostics, and operations | Incident time capsule: captures full system context (services, processes, logs, disk, network) in one call for debugging. Rate limited. | `{ action: "string (capture|list|get|delete|analyze)", name: "string (optional, incident name)", include: "array (optional, services|processes|logs|disk|network|all - default all)", analyze_with_llm: "boolean (optional, use LLM for analysis - default false)", incident_id: "string (optional, incident ID)" }` |
| `sidekick_respond` | AI, learning, and self-extension | Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed. | `{ text: "string (the response text to return)" }` |
| `sidekick_db_schema` | Database | Inspect database schema: tables, columns, indexes, foreign keys | `{ table: "string (optional, specific table name)", verbose: "boolean (optional, include row counts and detailed info)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }` |
| `sidekick_db_query` | Database | Execute raw SQL queries with safety limits (readonly by default) | `{ sql: "string", params: "array (optional)", readonly: "boolean (optional, default true)", limit: "number (optional, default 1000)", timeout: "number (optional, default 5000)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }` |
| `sidekick_db_stats` | Database | Database statistics: size, table sizes, WAL status, cache hit ratio | `{ detailed: "boolean (optional)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }` |
| `sidekick_db_backup` | Database | Create timestamped database backup with optional compression | `{ path: "string (optional)", compress: "boolean (optional, default true)" }` |
| `sidekick_db_restore` | Database | Restore database from backup with integrity verification | `{ path: "string", verify: "boolean (optional, default true)" }` |
| `sidekick_log_query` | Database | Advanced tool_logs filtering by time, tool, source, status | `{ tool: "string (optional)", source: "string (optional)", success: "boolean (optional)", since: "string (optional)", until: "string (optional)", limit: "number (optional)" }` |
| `sidekick_db_export` | Database | Export tables to JSON, CSV, or SQL format | `{ table: "string (optional)", format: "string (optional, json|csv|sql)", path: "string (optional)", database: "string (optional, 'sqlite' or 'postgres')" }` |
| `sidekick_db_search` | Database | Full-text search across all tables | `{ query: "string", tables: "string (optional, comma-separated)", limit: "number (optional)", database: "string (optional, 'sqlite' or 'postgres')" }` |
| `sidekick_db_migrate` | Database | Schema migrations with versioning | `{ action: "string (status|list|up)", version: "number (optional)", name: "string (optional)" }` |
| `sidekick_db_diff` | Database | Compare two database snapshots, show what changed | `{ snapshot_a: "string (optional)", snapshot_b: "string (optional)", table: "string (optional)" }` |
| `sidekick_redis` | Storage | Redis operations. Requires sidekick-redis service. | `{ action: "string (get|set|del|keys|ttl|info|flush)", key: "string (optional)", value: "string (optional)", ttl: "string (optional)", pattern: "string (optional)" }` |
| `sidekick_ocr` | Media | Extract text from images using Tesseract OCR | `{ path: "string", language: "string (optional)", psm: "number (optional)" }` |
| `sidekick_media` | Media | Media processing with ffmpeg: convert, extract audio, thumbnails, resize, trim, info | `{ action: "string", input: "string", output: "string (optional)", options: "string (optional)" }` |
| `sidekick_transcribe` | Media | Transcribe audio/video to text using Whisper | `{ path: "string", model: "string (optional)", language: "string (optional)" }` |
| `sidekick_analytics` | Database | Fast analytical queries on CSV/JSON/Parquet files using DuckDB | `{ query: "string", file: "string (optional)", format: "string (optional)" }` |
| `sidekick_embed` | Context & Learning | Generate text embeddings using Ollama | `{ text: "string", model: "string (optional)" }` |
| `sidekick_ollama` | Context & Learning | Manage Ollama models: list, ps, pull, show | `{ action: "string (list|ps|pull|show)", model: "string (optional)" }` |
| `sidekick_tunnel` | Networking | Manage Cloudflare tunnels: start, stop, list | `{ action: "string (start|stop|list)", port: "number", name: "string (optional)" }` |
| `sidekick_download` | Media | Download videos/audio using yt-dlp | `{ url: "string", output: "string (optional)", format: "string (optional)", audio_only: "boolean (optional)" }` |
| `sidekick_wireguard` | Networking | Manage WireGuard VPN peers and keys | `{ action: "string", interface_name: "string", peer_name: "string", public_key: "string", endpoint: "string (optional)", allowed_ips: "string (optional)" }` |
| `sidekick_nginx` | Networking | Manage Nginx reverse proxy sites | `{ action: "string", site_name: "string", domain: "string", upstream_port: "number", ssl_email: "string (optional)" }` |
| `sidekick_knowledge` | Context & Learning | Knowledge base management: search, get, list, add, update, delete entries | `{ action: "string (search|get|list|add|update|delete)", id: "number (optional)", category: "string (optional)", title: "string (optional)", content: "string (optional)", tags: "string (optional)", query: "string (optional)", limit: "number (optional)" }` |
| `sidekick_metrics` | Monitoring | Metrics collection and querying with InfluxDB | `{ action: "string (write|query|list_measurements|list_fields)", measurement: "string (optional)", fields: "object (optional)", tags: "object (optional)", timestamp: "number (optional)", query: "string (optional)", time_range: "string (optional)" }` |


## Core file, shell, and code operations

### `sidekick_bash`

Execute a shell command on the remote machine

Arguments: `{ command: "string" }`

### `sidekick_read`

Read a file from the remote filesystem

Arguments: `{ path: "string" }`

### `sidekick_write`

Write content to a file on the remote machine

Arguments: `{ path: "string", content: "string" }`

### `sidekick_list`

List files and directories on the remote machine

Arguments: `{ path: "string" }`

### `sidekick_web_fetch`

Fetch a URL from the remote machine

Arguments: `{ url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" }`

### `sidekick_search`

Search file contents using ripgrep or grep

Arguments: `{ pattern: "string", path: "string (optional)", include: "string (optional)" }`

### `sidekick_git`

Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash)

Arguments: `{ action: "string", path: "string (optional)", args: "string (optional)" }`

### `sidekick_process`

Manage processes (list, top CPU/memory, kill, tree)

Arguments: `{ action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" }`

### `sidekick_service`

Manage systemd services (start, stop, restart, status, enable, disable, logs)

Arguments: `{ action: "string", service: "string", lines: "number (optional)" }`

### `sidekick_archive`

Create, extract, or list archives (tar.gz, zip)

Arguments: `{ action: "string", path: "string", output: "string (optional)", format: "string (optional)" }`

## Persistent memory and project context

### `sidekick_store`

Store a value persistently in KV storage

Arguments: `{ key: "string", value: "string", project: "string (optional)" }`

### `sidekick_get`

Retrieve a stored value from KV storage

Arguments: `{ key: "string" }`

### `sidekick_list_projects`

List all unique project names in KV storage

Arguments: `{}`

### `sidekick_get_by_project`

Get all keys and values for a specific project

Arguments: `{ project: "string" }`

### `sidekick_context`

Persistent intelligent context management (track projects, decisions, problems, patterns, sessions, automatic memories; recall and suggest based on past context)

Arguments: `{ action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional: decisions|problems|patterns|projects|sessions|memories|all)", limit: "number (optional)" }`

### `sidekick_debug_tool`

Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries.

Arguments: `{ action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" }`

### `sidekick_project`

Get complete project context in one call: KV entries, context tracking, recent logs, procedures.

Arguments: `{ name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" }`

## AI, learning, and self-extension

### `sidekick_llm`

Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq)

Arguments: `{ prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" }`

### `sidekick_teach`

Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows

Arguments: `{ action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" }`

### `sidekick_evolve`

Self-modification with safety: analyze patterns, propose improvements, test and approve changes

Arguments: `{ action: "string (analyze|propose|list|test|approve|reject)", id: "string (optional, proposal id for test/approve/reject)", proposal: "string (optional, proposal description for propose)", approve: "boolean (optional, deprecated - use action=approve)", test: "boolean (optional, deprecated - use action=test)" }`

### `sidekick_predict`

Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness

Arguments: `{ action: "string (analyze|list|feedback|suggest)", id: "string (optional, prediction id for feedback)", feedback: "boolean (optional, true if useful, false if not)" }`

### `sidekick_fresheyes`

Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis

Arguments: `{ problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" }`

### `sidekick_respond`

Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed.

Arguments: `{ text: "string (the response text to return)" }`

## Database, knowledge, and optional infrastructure

### SQLite-backed registry and logs

The built-in database tools operate on SQLite by default and can target PostgreSQL where supported with `database: "postgres"`. Read-only query mode is the default for `sidekick_db_query` and rejects mutating or multi-statement SQL.

Important tools in this group:

- `sidekick_db_schema`, `sidekick_db_query`, `sidekick_db_stats`, `sidekick_db_backup`, `sidekick_db_restore`, `sidekick_db_export`, `sidekick_db_search`, `sidekick_db_migrate`, and `sidekick_db_diff`.
- `sidekick_log_query` reads the SQLite `tool_logs` table.
- `sidekick_knowledge` manages the SQLite `knowledge` table used by `AGENTS.md`.

### Optional services

`sidekick_redis`, `sidekick_metrics`, `sidekick_embed`, `sidekick_ollama`, `sidekick_tunnel`, `sidekick_wireguard`, `sidekick_nginx`, `sidekick_ocr`, `sidekick_media`, `sidekick_transcribe`, `sidekick_download`, and `sidekick_analytics` depend on optional services or binaries installed by `scripts/setup-tools.sh`.

## External integrations and secrets

### `sidekick_notify`

Send notifications to Discord, Slack, or email

Arguments: `{ channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" }`

### `sidekick_github`

GitHub API integration (PRs, issues, commits, releases)

Arguments: `{ action: "string", repo: "string", args: "string (optional)" }`

### `sidekick_webhook`

Manage received webhooks (list, get, clear)

Arguments: `{ action: "string", id: "string (optional)", limit: "number (optional)" }`

### `sidekick_secret`

Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env)

Arguments: `{ action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" }`

### `sidekick_sandbox`

Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems.

Arguments: `{ action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" }`

## Automation, scheduling, and orchestration

### `sidekick_cron`

Schedule recurring tasks (add, list, remove, run jobs)

Arguments: `{ action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" }`

### `sidekick_delay`

One-shot task scheduling: run a tool once at a specific time or after a delay

Arguments: `{ action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" }`

### `sidekick_watch`

Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions

Arguments: `{ action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" }`

### `sidekick_queue`

Persistent task queue with priorities

Arguments: `{ action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" }`

### `sidekick_retry`

Retry tool calls with exponential backoff

Arguments: `{ tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" }`

### `sidekick_orchestrate`

Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress

Arguments: `{ action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" }`

### `sidekick_batch`

Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch.

Arguments: `{ calls: "array (array of { tool: string, args: object })" }`

### `sidekick_circuit`

Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down.

Arguments: `{ action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" }`

### `sidekick_runbook`

Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution.

Arguments: `{ action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" }`

## Data processing and document utilities

### `sidekick_transform`

Data manipulation pipeline: filter, extract, sort, format, and map data

Arguments: `{ action: "string (filter|extract|sort|format|map)", input: "string", pattern: "string (optional, for filter)", field: "string (optional, for extract)", key: "string (optional, for sort/map)", value: "string (optional, for map)", format: "string (optional, for format: json|csv|table|text)" }`

### `sidekick_parse`

Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection

Arguments: `{ input: "string (data to parse)", format: "string (optional, json|yaml|xml|ini|csv - auto-detected if not specified)" }`

### `sidekick_diff`

Semantic comparison of text, JSON, or YAML with structure-aware diffing

Arguments: `{ old_text: "string (original content)", new_text: "string (modified content)", type: "string (optional, text|json|yaml|auto - default auto)", format: "string (optional, unified|summary|json - default unified)" }`

### `sidekick_hash`

Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification

Arguments: `{ input: "string (optional, data to hash)", path: "string (optional, file path to hash)", algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)", verify: "string (optional, expected hash to verify against)" }`

### `sidekick_validate`

Validate data against JSON Schema

Arguments: `{ data: "string|object (data to validate)", schema: "string|object (JSON Schema)" }`

### `sidekick_template`

Render Handlebars templates with data

Arguments: `{ template: "string (Handlebars template)", data: "string|object (template data)" }`

### `sidekick_cache`

Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL.

Arguments: `{ action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" }`

### `sidekick_extract`

Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need.

Arguments: `{ path: "string (file path)", fields: "string|array (optional, field paths to extract e.g. 'database.host,database.port')" }`

### `sidekick_anonymize`

Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally.

Arguments: `{ action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" }`

### `sidekick_changelog`

Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries.

Arguments: `{ action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" }`

## Monitoring, diagnostics, and operations

### `sidekick_health`

Composite system health checks with scoring and issue detection

Arguments: `{ check: "string (all|services|processes|disk|network|custom)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" }`

### `sidekick_snapshot`

Capture system state and detect drift by comparing snapshots

Arguments: `{ action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" }`

### `sidekick_summarize`

Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats.

Arguments: `{ path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" }`

### `sidekick_filter`

Filter file contents or directory listings by pattern, date, or size before returning.

Arguments: `{ path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" }`

### `sidekick_tail`

Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file.

Arguments: `{ source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" }`

### `sidekick_diff_files`

Compare two files directly without reading both into context. Returns unified diff or summary.

Arguments: `{ path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" }`

### `sidekick_find`

Advanced file finder: search by name pattern, date range, size range, and content pattern.

Arguments: `{ path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" }`

### `sidekick_status`

Unified system status: services, disk, memory, load, uptime, top processes in one call.

Arguments: `{ include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" }`

### `sidekick_netdiag`

Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners.

Arguments: `{ action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" }`

### `sidekick_timeline`

Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications.

Arguments: `{ action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" }`

### `sidekick_baseline`

Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations.

Arguments: `{ action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" }`

### `sidekick_depend`

Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis.

Arguments: `{ action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" }`

### `sidekick_black_box`

Incident time capsule: captures full system context (services, processes, logs, disk, network) in one call for debugging. Rate limited.

Arguments: `{ action: "string (capture|list|get|delete|analyze)", name: "string (optional, incident name)", include: "array (optional, services|processes|logs|disk|network|all - default all)", analyze_with_llm: "boolean (optional, use LLM for analysis - default false)", incident_id: "string (optional, incident ID)" }`


## Dispatcher behavior

All agent-side tool calls should go through `callTool(name, args)`. The dispatcher looks up the handler in `TOOLS`, records start time, executes the handler, logs success/failure through `logToolCall`, and returns a normalized MCP-style result.

Unknown tool names return an error result instead of throwing. Exceptions inside handlers are caught, logged, and converted to an error result.

## Redaction behavior

Tool output is passed through `redactSensitive` in many handlers before being returned or logged. This is intended to prevent accidental leakage of private keys, tokens, passwords, and similar material. Redaction is a safety layer, not a substitute for avoiding dangerous commands or overbroad file reads.
