# Tools Reference

This catalog reflects the descriptor registry and compatibility definitions exported through `src/tools/index.js`. Current `main` contains 107 built-in tools across 20 categories. Approved trial/active generated capabilities are additional runtime tools and are not included in the built-in count. The runtime `tools` table and `tools` manifest remain authoritative for enabled/deprecated and generated-tool state.

Tool names below use the canonical MCP form: `bash`, `knowledge`, `compute_jobs`, and so on. The dispatcher and registry still normalize older `sidekick_`-prefixed names for compatibility, but those aliases are deprecated for documentation and new integrations.

Tool definitions exposed by the dashboard API include policy metadata:

- `risk`: `low`, `medium`, `high`, or `critical`
- `enabled`: whether the active source policy allows the tool
- `policy`: short reason for the policy decision
- `approval_required`: whether the active source approval policy queues the tool before execution

## Risk classification

Risk is based on what a tool can change or expose, not whether its implementation is currently safe.

| Risk | Tools | Default recommendation |
|---|---|---|
| Critical | `bash`, `write`, `db_restore`, `runbook`, `ops`, `mission`, `sandbox`, `evolve` | Gate in shared or public deployments. Allow only for trusted operators. |
| High | `process`, `service`, `cron`, `delay`, `watch`, `github`, `teach`, `secret`, `db_migrate`, `queue`, `orchestrate`, `health`, `netdiag`, `baseline`, `tunnel`, `wireguard`, `nginx` | Block in `restricted` mode unless the workflow needs them. |
| Medium | `notify`, `read`, `archive`, `git`, `web_fetch`, `llm`, `context`, `session`, `handoff`, `memory`, `memory_import`, `memory_manage`, `sync_import`, `snapshot`, `retry`, `fresheyes`, `batch`, `tail`, `find`, `status`, `extract`, `changelog`, `timeline`, `circuit`, `depend`, `black_box`, `db_query`, `db_backup`, `db_export`, `redis`, `ocr`, `media`, `transcribe`, `analytics`, `download`, `compute`, `compute_nodes`, `compute_providers`, `compute_jobs`, `compute_route` | Generally useful, but can expose data or trigger external effects. |
| Low | `ci_status`, `security_scan`, `memory_export`, `sync_identity`, `sync_export`, `sync_diff`, `insight_report`, `embed`, `ollama`, `tools`, `respond`, `list`, `store`, `get`, `list_projects`, `get_by_project`, `search`, `webhook`, `transform`, `parse`, `diff`, `hash`, `validate`, `template`, `predict`, `debug_tool`, `cache`, `summarize`, `filter`, `project`, `diff_files`, `anonymize`, `db_schema`, `db_stats`, `log_query`, `db_search`, `db_diff`, `knowledge`, `compute_models`, `delete`, `resume`, `metrics` | Usually safe to expose, subject to data sensitivity. |

Use `SIDEKICK_TOOL_POLICY=restricted` to block high and critical tools by default. Use `SIDEKICK_ALLOWED_TOOLS`, `SIDEKICK_BLOCKED_TOOLS`, and source-specific variants such as `SIDEKICK_AGENT_ALLOWED_TOOLS` for deployment-specific control.

Use `tools` with `action="policy"` to inspect effective policy and approval decisions without changing configuration:

```javascript
tools({ action: "policy", source: "mcp,dashboard,agent", name: "bash", format: "json" })
```

Filesystem path guardrails are optional and default to open. Use `SIDEKICK_ALLOWED_PATHS` and `SIDEKICK_DENIED_PATHS` to constrain direct file and repository path arguments, with source-specific variants such as `SIDEKICK_AGENT_ALLOWED_PATHS`. Denied paths win over allowed paths.

## Full inventory

| Tool | Category | Description | Argument summary |
|---|---|---|---|
| `bash` | Core | Execute a shell command on the remote machine | `{ command: "string" }` |
| `tools` | Core | Tool catalog, discovery manifest, and policy inspector. Use for broad questions like "what Sidekick tools are available?", "list available tools", "tool overview", "tool manifest", or "why is this tool blocked?". Lists tools grouped by category, searches by capability, gets exact tool metadata, and inspects effective policy/approval decisions. | `{ action: "string (overview|search|get|policy - default overview)", query: "string (optional)", name: "string (optional)", category: "string (optional)", source: "string (optional)", format: "string (optional, text|json - default text)", include_disabled: "boolean (optional)", limit: "number (optional)" }` |
| `read` | Core | Read a file from the remote filesystem | `{ path: "string" }` |
| `write` | Core | Write content to a file on the remote machine | `{ path: "string", content: "string" }` |
| `list` | Core | List files and directories on the remote machine | `{ path: "string" }` |
| `store` | Storage | Store a value persistently in KV storage | `{ key: "string", value: "string", project: "string (optional)" }` |
| `get` | Storage | Retrieve a stored value from KV storage | `{ key: "string" }` |
| `delete` | Storage | Delete a stored value from KV storage by key | `{ key: "string" }` |
| `resume` | Storage | Manage first-class project resume handoffs stored in the resume document. Use to check, set, clear, or list pending work without relying on ad hoc KV keys. | `{ action: "string (check|set|clear|list - default check)", project: "string (required for check/set/clear)", summary: "string (optional)", next_step: "string (optional)", status: "string (optional)", branch: "string (optional)", url: "string (optional)", notes: "string (optional)", include_cleared: "boolean (optional)", format: "string (optional, text|json - default text)" }` |
| `web_fetch` | Core | Fetch a URL from the remote machine | `{ url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" }` |
| `llm` | Core | Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq) | `{ prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" }` |
| `list_projects` | Storage | List all unique project names in KV storage | `{}` |
| `get_by_project` | Storage | Get all keys and values for a specific project | `{ project: "string" }` |
| `search` | Core | Search file contents using ripgrep or grep | `{ pattern: "string", path: "string (optional)", include: "string (optional)" }` |
| `git` | Git & GitHub | Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash) | `{ action: "string", path: "string (optional)", args: "string (optional)" }` |
| `notify` | Communication | Send notifications to Discord, Slack, or email | `{ channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" }` |
| `process` | Services | Manage processes (list, top CPU/memory, kill, tree) | `{ action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" }` |
| `service` | Services | Manage systemd services (start, stop, restart, status, enable, disable, logs) | `{ action: "string", service: "string", lines: "number (optional)" }` |
| `archive` | Archive | Create, extract, or list archives (tar.gz, zip) | `{ action: "string", path: "string", output: "string (optional)", format: "string (optional)" }` |
| `cron` | Scheduling | Schedule recurring tasks (add, list, remove, run jobs) | `{ action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" }` |
| `github` | Git & GitHub | GitHub API integration (PRs, issues, commits, releases) | `{ action: "string", repo: "string", args: "string (optional)" }` |
| `ci_status` | Git & GitHub | Read-only GitHub CI/check-run inspection for a PR head, commit SHA, ref, or branch | `{ repo: "string (owner/repository)", pr: "number|string (optional)", pull_number: "number|string (optional)", sha: "string (optional)", commit: "string (optional)", ref: "string (optional)", branch: "string (optional)", format: "string (optional, text|json - default text)" }` |
| `webhook` | Communication | Manage received webhooks (list, get, clear) | `{ action: "string", id: "string (optional)", limit: "number (optional)" }` |
| `context` | Context & Learning | Persistent intelligent context management (track projects, decisions, problems, patterns, sessions, automatic memories; recall and suggest based on past context) | `{ action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional: decisions|problems|patterns|projects|sessions|memories|all)", limit: "number (optional)" }` |
| `session` | Context & Learning | Explicit task/session memory envelope for begin, update, checkpoint, end, abandon, resume, status, and list operations | `{ action: "string (begin|update|checkpoint|end|abandon|resume|status|list)", id: "string (optional)", goal: "string (required for begin)", project: "string (optional)", source: "string (optional)", working_directory: "string (optional)", repository: "string (optional)", branch: "string (optional)", environment: "string (optional)", tags: "string|array (optional)", current_plan: "string (optional)", completed_steps: "array (optional)", blockers: "array (optional)", next_step: "string (optional)", outcome: "string (optional)", final_summary: "string (optional)", acceptance_state: "string (optional)", verified_facts: "array (optional)", decisions: "array (optional)", failed_approaches: "array (optional)", follow_ups: "array (optional)" }` |
| `handoff` | Context & Learning | First-class handoff storage and ingestion with idempotent, redacted, evidence-linked memory extraction | `{ action: "string (create|update|get|list|compare|inspect|reprocess|archive)", id: "string (optional)", key: "string (optional)", project: "string (optional)", title: "string (optional)", content: "string (for create/update)", source: "string (optional)", task_id: "string (optional)", include_archived: "boolean (optional)", limit: "number (optional)" }` |
| `memory` | Context & Learning | Typed memory operations for remember, query, explain, correct, forget, pin, expire, conflicts, health, and backfill | `{ action: "string (remember|query|explain|list|get|confirm|correct|forget|pin|expire|conflicts|health|backfill)", id: "string (optional)", project: "string (optional)", type: "string (optional)", memory_class: "string (optional)", content: "string (for remember)", summary: "string (optional)", scope_type: "string (optional)", scope_id: "string (optional)", source: "string (optional)", evidence: "string (optional)", confidence: "number (optional)", tags: "string|array (optional)", query: "string (optional)", limit: "number (optional)", correct_to: "string (optional)", fresh_eyes: "boolean (optional)", historical: "boolean (optional)" }` |
| `teach` | Context & Learning | Teach and execute reusable procedures composed from existing tools | `{ action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" }` |
| `transform` | Data Pipeline | Data manipulation pipeline: filter, extract, sort, format, and map data | `{ action: "string (filter|extract|sort|format|map)", input: "string", pattern: "string (optional, for filter)", field: "string (optional, for extract)", key: "string (optional, for sort/map)", value: "string (optional, for map)", format: "string (optional, for format: json|csv|table|text)" }` |
| `health` | Monitoring | Composite system health checks with scoring and issue detection | `{ check: "string (all|services|processes|disk|network|custom)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" }` |
| `delay` | Scheduling | One-shot task scheduling: run a tool once at a specific time or after a delay | `{ action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" }` |
| `snapshot` | Monitoring | Capture system state and detect drift by comparing snapshots | `{ action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" }` |
| `watch` | Monitoring | Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions | `{ action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" }` |
| `secret` | Security | Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env) | `{ action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" }` |
| `security_scan` | Security | Read-only audit for tracked sensitive files, secret signatures, hardcoded credential settings, runtime .env safety, and sensitive-file permissions. Reports metadata only and never returns secret values. | `{ path: "string (optional)", max_files: "number (optional, 1-10000)", format: "string (optional, text|json)" }` |
| `parse` | Data Pipeline | Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection | `{ input: "string (data to parse)", format: "string (optional, json|yaml|xml|ini|csv - auto-detected if not specified)" }` |
| `diff` | Data Pipeline | Semantic comparison of text, JSON, or YAML with structure-aware diffing | `{ old_text: "string (original content)", new_text: "string (modified content)", type: "string (optional, text|json|yaml|auto - default auto)", format: "string (optional, unified|summary|json - default unified)" }` |
| `hash` | Data Pipeline | Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification | `{ input: "string (optional, data to hash)", path: "string (optional, file path to hash)", algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)", verify: "string (optional, expected hash to verify against)" }` |
| `validate` | Data Pipeline | Validate data against JSON Schema | `{ data: "string|object (data to validate)", schema: "string|object (JSON Schema)" }` |
| `template` | Data Pipeline | Render Handlebars templates with data | `{ template: "string (Handlebars template)", data: "string|object (template data)" }` |
| `queue` | Workflow | Persistent task queue with priorities | `{ action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" }` |
| `retry` | Workflow | Retry tool calls with exponential backoff | `{ tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" }` |
| `evolve` | Meta | Evidence-driven workflow learning and generated-tool lifecycle management | `{ action: "string (analyze|candidates|inspect|validate|approve|activate_trial|promote|reject|deprecate|feedback|report)", id: "string (optional)", proposal: "string (optional structured JSON)", approver: "string (optional)", useful: "boolean (optional)", reason: "string (optional)" }` |
| `orchestrate` | Workflow | Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress | `{ action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" }` |
| `predict` | Meta | Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness | `{ action: "string (analyze|list|feedback|suggest)", id: "string (optional, prediction id for feedback)", feedback: "boolean (optional, true if useful, false if not)" }` |
| `debug_tool` | Meta | Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries. | `{ action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" }` |
| `fresheyes` | Meta | Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis | `{ problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" }` |
| `batch` | Efficiency | Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch. | `{ calls: "array (array of { tool: string, args: object })" }` |
| `cache` | Efficiency | Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL. | `{ action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" }` |
| `summarize` | Efficiency | Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats. | `{ path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" }` |
| `filter` | Efficiency | Filter file contents or directory listings by pattern, date, or size before returning. | `{ path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" }` |
| `project` | Efficiency | Get complete project context in one call: KV entries, context tracking, recent logs, procedures. | `{ name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" }` |
| `tail` | Efficiency | Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file. | `{ source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" }` |
| `diff_files` | Data Pipeline | Compare two files directly without reading both into context. Returns unified diff or summary. | `{ path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" }` |
| `find` | Efficiency | Advanced file finder: search by name pattern, date range, size range, and content pattern. | `{ path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" }` |
| `status` | Monitoring | Unified system status: services, disk, memory, load, uptime, top processes in one call. | `{ include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" }` |
| `extract` | Data Pipeline | Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need. | `{ path: "string (file path)", fields: "string|array (optional, field paths to extract e.g. 'database.host,database.port')" }` |
| `anonymize` | Data Pipeline | Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally. | `{ action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" }` |
| `sandbox` | Security | Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems. | `{ action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" }` |
| `changelog` | Development | Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries. | `{ action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" }` |
| `netdiag` | Monitoring | Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners. | `{ action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" }` |
| `timeline` | Monitoring | Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications. | `{ action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" }` |
| `circuit` | Reliability | Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down. | `{ action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" }` |
| `baseline` | Monitoring | Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations. | `{ action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" }` |
| `depend` | Development | Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis. | `{ action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" }` |
| `runbook` | Workflow | Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution. | `{ action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" }` |
| `ops` | Workflow | Packaged Sidekick operations workflows for deploy verification, restart smoke tests, deployments, and incident snapshots. | `{ action: "string (verify_deployed_commit|restart_and_smoke_test|deploy_current_main|incident_snapshot)", repo_path: "string (optional, repository path - default current Sidekick repo)", restart_mcp: "boolean (optional, schedule sidekick-mcp restart for restart_and_smoke_test)" }` |
| `mission` | Workflow | Mission Control intent router for Sidekick operations. Profiles, routes, preflights, and executes common intents through safer existing tools before raw shell. | `{ action: "string (profiles|route|preflight|execute - default route)", intent: "string", profile: "string (read_only_audit|trusted_vps|production|danger_zone)", confirm: "boolean (required true for mutation)", key: "string (optional)", project: "string (optional)", query: "string (optional)", repo_path: "string (optional)" }` |
| `black_box` | Monitoring | Structured incident evidence system: captures configured context, stores incidents/captures/sources/observations, supports source inspection, search, analysis, comparison, retention, export, and legacy raw views. | `{ action: "string (capture|capture_status|cancel_capture|list|list_incidents|get|get_incident|list_captures|get_capture|list_sources|get_source|search|analyze|compare|add_note|update_incident|pin|extend_retention|archive|export|delete|storage_status|purge_preview|purge|profiles)", name: "string (optional)", profile: "string (optional)", include: "array (optional)", incident_id: "string (optional)", capture_id: "string (optional)", source_id: "string (optional)", query: "string (optional)" }` |
| `respond` | Core | Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed. | `{ text: "string (the response text to return)" }` |
| `db_schema` | Database | Inspect database schema: tables, columns, indexes, foreign keys | `{ table: "string (optional, specific table name)", verbose: "boolean (optional, include row counts and detailed info)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }` |
| `db_query` | Database | Execute raw SQL queries with safety limits (readonly by default) | `{ sql: "string", params: "array (optional)", readonly: "boolean (optional, default true)", limit: "number (optional, default 1000)", timeout: "number (optional, default 5000)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }` |
| `db_stats` | Database | Database statistics: size, table sizes, WAL status, cache hit ratio | `{ detailed: "boolean (optional)", database: "string (optional, 'sqlite' or 'postgres' - default sqlite)" }` |
| `db_backup` | Database | Create timestamped database backup with optional compression | `{ path: "string (optional)", compress: "boolean (optional, default true)" }` |
| `db_restore` | Database | Restore database from backup with integrity verification | `{ path: "string", verify: "boolean (optional, default true)" }` |
| `log_query` | Database | Advanced tool_logs filtering by time, tool, source, status | `{ tool: "string (optional)", source: "string (optional)", success: "boolean (optional)", since: "string (optional)", until: "string (optional)", limit: "number (optional)" }` |
| `db_export` | Database | Export tables to JSON, CSV, or SQL format | `{ table: "string (optional)", format: "string (optional, json|csv|sql)", path: "string (optional)", database: "string (optional, 'sqlite' or 'postgres')" }` |
| `db_search` | Database | Full-text search across all tables | `{ query: "string", tables: "string (optional, comma-separated)", limit: "number (optional)", database: "string (optional, 'sqlite' or 'postgres')" }` |
| `db_migrate` | Database | Schema migrations with versioning | `{ action: "string (status|list|up)", version: "number (optional)", name: "string (optional)" }` |
| `db_diff` | Database | Compare two database snapshots, show what changed | `{ snapshot_a: "string (optional)", snapshot_b: "string (optional)", table: "string (optional)" }` |
| `redis` | Storage | Redis operations. Requires sidekick-redis service. | `{ action: "string (get|set|del|keys|ttl|info|flush)", key: "string (optional)", value: "string (optional)", ttl: "string (optional)", pattern: "string (optional)" }` |
| `ocr` | Media | Extract text from images using Tesseract OCR | `{ path: "string", language: "string (optional)", psm: "number (optional)" }` |
| `media` | Media | Media processing with ffmpeg: convert, extract audio, thumbnails, resize, trim, info | `{ action: "string", input: "string", output: "string (optional)", options: "string (optional)" }` |
| `transcribe` | Media | Transcribe audio/video to text using Whisper | `{ path: "string", model: "string (optional)", language: "string (optional)" }` |
| `analytics` | Database | Fast analytical queries on CSV/JSON/Parquet files using DuckDB | `{ query: "string", file: "string (optional)", format: "string (optional)" }` |
| `insight_report` | Data Pipeline | Create a concise, evidence-backed report from text, data, or image file paths | `{ paths: "string|array", title: "string (optional)" }` |
| `embed` | Context & Learning | Generate text embeddings using Ollama | `{ text: "string", model: "string (optional)" }` |
| `ollama` | Context & Learning | Manage Ollama models: list, ps, pull, show | `{ action: "string (list|ps|pull|show)", model: "string (optional)" }` |
| `tunnel` | Networking | Manage Cloudflare tunnels: start, stop, list | `{ action: "string (start|stop|list)", port: "number", name: "string (optional)" }` |
| `download` | Media | Download videos/audio using yt-dlp | `{ url: "string", output: "string (optional)", format: "string (optional)", audio_only: "boolean (optional)" }` |
| `wireguard` | Networking | Manage WireGuard VPN peers and keys | `{ action: "string", interface_name: "string", peer_name: "string", public_key: "string", endpoint: "string (optional)", allowed_ips: "string (optional)" }` |
| `nginx` | Networking | Manage Nginx reverse proxy sites | `{ action: "string", site_name: "string", domain: "string", upstream_port: "number", ssl_email: "string (optional)" }` |
| `knowledge` | Context & Learning | Knowledge base management: search, get, list, add, update, soft-delete, and purge disabled entries | `{ action: "string (search|get|list|add|update|delete|purge)", id: "number (optional)", category: "string (optional)", title: "string (optional)", content: "string (optional)", tags: "string (optional)", query: "string (optional)", limit: "number (optional)" }` |
| `metrics` | Monitoring | Metrics collection and querying with InfluxDB | `{ action: "string (write|query|list_measurements|list_fields)", measurement: "string (optional)", fields: "object (optional)", tags: "object (optional)", timestamp: "number (optional)", query: "string (optional)", time_range: "string (optional)" }` |
| `compute` | Compute | Sidekick Compute overview and initialization for the provider-neutral inference/compute subsystem | `{ action: "string (overview|init)" }` |
| `compute_nodes` | Compute | Manage compute workers and enrollment tokens: list, inspect, heartbeat, revoke, maintenance, stats, token creation/listing, and enrollment | `{ action: "string (list|get|heartbeat|revoke|maintenance|stats|create_token|list_tokens|enroll)", node_id: "string (optional)", token: "string (optional)", display_name: "string (optional)", platform: "string (optional)", architecture: "string (optional)", reason: "string (optional)", enable: "boolean (optional)", status: "string (optional)", hardware_type: "string (optional)", provider: "string (optional)" }` |
| `compute_providers` | Compute | Manage compute providers such as Ollama, OpenAI-compatible, vLLM, llama.cpp, MLX, and mock providers | `{ action: "string (list|get|create|update|delete|health|health_all)", provider_id: "string (optional)", name: "string (optional)", type: "string (optional)", base_url: "string (optional)", api_key: "string (optional)", priority: "number (optional)", enabled: "boolean (optional)" }` |
| `compute_models` | Compute | Manage model inventory and provider discovery | `{ action: "string (list|get|create|update|delete|discover)", model_id: "string (optional)", provider_id: "string (optional)", model_name: "string (optional)", provider_model_name: "string (optional)", family: "string (optional)", parameter_count: "string (optional)", context_length: "number (optional)", supports_vision: "boolean (optional)", supports_tools: "boolean (optional)", supports_embedding: "boolean (optional)", min_vram_gb: "number (optional)" }` |
| `compute_jobs` | Compute | Manage allowlisted compute jobs, statistics, cancellation, and artifacts | `{ action: "string (list|get|create|cancel|stats|artifacts)", job_id: "string (optional)", job_type: "string (chat|generate|embeddings for create)", model: "string (optional)", prompt: "string (optional)", provider: "string (optional)", max_retries: "number (optional)", timeout_ms: "number (optional)", status: "string (optional)" }` |
| `compute_route` | Compute | Explain routing decisions and manage routing rules for allowlisted compute workloads | `{ action: "string (explain|list_rules|create_rule|delete_rule)", workload_class: "string (optional)", capabilities_required: "string (optional)", data_classification: "string (optional)", trust_level: "string (optional)", rule_id: "string (optional)", rule_name: "string (optional)", priority: "number (optional)", description: "string (optional)", preferred_providers: "array (optional)", preferred_models: "array (optional)", fallback_providers: "array (optional)", max_latency_ms: "number (optional)" }` |
| `memory_export` | Context & Learning | Export structured memories to JSON for backup, portability, or machine-to-machine transfer | `{ project: "string (optional)", type: "string (optional)", include_disabled: "boolean (optional)", automatic_only: "boolean (optional)" }` |
| `memory_import` | Context & Learning | Import memories from JSON export with merge or skip conflict handling | `{ data: "string|object", on_conflict: "string (optional, merge|skip)", preserve_ids: "boolean (optional)" }` |
| `memory_manage` | Context & Learning | Manage memory lifecycle: confirm, delete, disable, expire, restore, set auto-expire, list by state, pending confirmations, process auto-expirations | `{ action: "string (confirm|set_requires_confirmation|delete|disable|expire|restore|set_auto_expire|list_by_state|pending_confirmations|process_auto_expirations)", id: "string", confirmed_by: "string (optional)", days: "number (optional)", reason: "string (optional)", limit: "number (optional)", project: "string (optional)" }` |
| `sync_identity` | Context & Learning | Manage machine and user identity for cross-machine sync | `{ action: "string (get|set_user)", user_id: "string (optional)" }` |
| `sync_export` | Context & Learning | Export memories for cross-machine sync with origin tracking and sync metadata | `{ project: "string (optional)", since: "string (optional)", include_disabled: "boolean (optional)" }` |
| `sync_import` | Context & Learning | Import memories from another machine with conflict resolution strategies | `{ data: "string|object", strategy: "string (optional, newest|highest_confidence|most_confirmed|merge|skip)", preserve_ids: "boolean (optional)" }` |
| `sync_diff` | Context & Learning | Get list of memories changed since a given timestamp for incremental sync | `{ since: "string" }` |


## Core file, shell, and code operations

### `bash`

Execute a shell command on the remote machine

Arguments: `{ command: "string" }`

### `read`

Read a file from the remote filesystem

Arguments: `{ path: "string" }`

### `write`

Write content to a file on the remote machine

Arguments: `{ path: "string", content: "string" }`

### `list`

List files and directories on the remote machine

Arguments: `{ path: "string" }`

### `web_fetch`

Fetch a URL from the remote machine

Arguments: `{ url: "string", method: "string (optional)", headers: "string (optional)", body: "string (optional)" }`

### `search`

Search file contents using ripgrep or grep

Arguments: `{ pattern: "string", path: "string (optional)", include: "string (optional)" }`

### `git`

Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash)

Arguments: `{ action: "string", path: "string (optional)", args: "string (optional)" }`

### `process`

Manage processes (list, top CPU/memory, kill, tree)

Arguments: `{ action: "string", filter: "string (optional)", pid: "number (optional)", name: "string (optional)", signal: "string (optional)" }`

### `service`

Manage systemd services (start, stop, restart, status, enable, disable, logs)

Arguments: `{ action: "string", service: "string", lines: "number (optional)" }`

### `archive`

Create, extract, or list archives (tar.gz, zip)

Arguments: `{ action: "string", path: "string", output: "string (optional)", format: "string (optional)" }`

## Persistent memory and project context

### `store`

Store a value persistently in KV storage

Arguments: `{ key: "string", value: "string", project: "string (optional)" }`

### `get`

Retrieve a stored value from KV storage

Arguments: `{ key: "string" }`

### `delete`

Delete a stored value from KV storage by key

Arguments: `{ key: "string" }`

### `list_projects`

List all unique project names in KV storage

Arguments: `{}`

### `get_by_project`

Get all keys and values for a specific project

Arguments: `{ project: "string" }`

### `resume`

Manage first-class project resume handoffs stored in the `resume` document.

Arguments: `{ action: "string (check|set|clear|list - default check)", project: "string (required for check/set/clear)", summary: "string (optional, for set)", next_step: "string (optional, for set)", status: "string (optional, for set - default active)", branch: "string (optional, for set)", url: "string (optional, for set)", notes: "string (optional)", include_cleared: "boolean (optional, for list)", format: "string (optional, text|json - default text)" }`

Use `check` at session startup, `set` when leaving pending work, `clear` after completing a handoff, and `list` to see all active project resume items.

### `context`

Persistent intelligent context management (track projects, decisions, problems, patterns, sessions, automatic memories; recall and suggest based on past context)

Arguments: `{ action: "string", project: "string (optional)", context: "string (optional)", decision: "string (optional)", reasoning: "string (optional)", problem: "string (optional)", solution: "string (optional)", pattern: "string (optional)", query: "string (optional)", type: "string (optional: decisions|problems|patterns|projects|sessions|memories|all)", limit: "number (optional)" }`

`recall` accepts exact IDs such as `sess_...` and `mem_...` in addition to keyword queries. Disabled, deleted, and expired context entries are excluded from recall.

### `debug_tool`

Structured debugging cache with persistent storage for cross-session debugging. Store findings, recall past investigations, cleanup old entries.

Arguments: `{ action: "string (store|recall|cleanup|start|stop|cache|get|status|clear)", session_name: "string (optional, session identifier for legacy actions)", key: "string (optional, cache key for get/cache, or debug key for cleanup)", value: "string (optional, value to cache/store)", service: "string (optional, service name for store/recall)", issue: "string (optional, issue description for store)", redact: "boolean (optional, default true - set false to skip redaction)" }`

### `project`

Get complete project context in one call: KV entries, context tracking, recent logs, procedures.

Arguments: `{ name: "string (project name)", include: "string (optional, comma-separated: kv,context,logs,procedures - default kv,context)" }`

### `memory_export`

Export structured memories to JSON for backup, portability, or machine-to-machine transfer.

Arguments: `{ project: "string (optional, filter by project)", type: "string (optional, filter by memory type)", include_disabled: "boolean (optional, include disabled memories - default true)", automatic_only: "boolean (optional, only automatic memories - default false)" }`

### `memory_import`

Import memories from JSON export. Supports merge or skip conflict modes.

Arguments: `{ data: "string|object (JSON export data or parsed object)", on_conflict: "string (optional, merge|skip - default merge)", preserve_ids: "boolean (optional, preserve original IDs - default false)" }`

### `memory_manage`

Manage memory lifecycle: confirm, delete, disable, expire, restore, set auto-expire, list by state, pending confirmations, and process auto-expirations.

Arguments: `{ action: "string (confirm|set_requires_confirmation|delete|disable|expire|restore|set_auto_expire|list_by_state|pending_confirmations|process_auto_expirations)", id: "string (memory/context ID, or state name for list_by_state)", confirmed_by: "string (optional, who confirmed - default 'user')", days: "number (for set_auto_expire)", reason: "string (optional, reason for delete/disable/expire)", limit: "number (optional, for list operations - default 50)", project: "string (optional, filter by project for list operations)" }`

Structured memories in the `memories` table support the full lifecycle. Legacy context entries in the `context` document, including `sess_...` session IDs, support `delete`, `disable`, `expire`, and `restore`; structured-only actions return an explicit unsupported-ID error for those IDs.

### `sync_identity`

Manage machine and user identity for cross-machine sync.

Arguments: `{ action: "string (get|set_user)", user_id: "string (required for set_user action)" }`

### `sync_export`

Export memories for cross-machine sync with origin tracking and sync metadata.

Arguments: `{ project: "string (optional, filter by project)", since: "string (optional, ISO timestamp - only export memories updated after this time)", include_disabled: "boolean (optional, include disabled memories - default true)" }`

### `sync_import`

Import memories from another machine's sync export. Supports conflict resolution strategies.

Arguments: `{ data: "string|object (sync export data)", strategy: "string (optional, newest|highest_confidence|most_confirmed|merge|skip - default newest)", preserve_ids: "boolean (optional, preserve original IDs - default false)" }`

### `sync_diff`

Get the list of memories changed since a timestamp for incremental sync.

Arguments: `{ since: "string (ISO timestamp - get changes after this time)" }`

## AI, learning, and self-extension

### `llm`

Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq)

Arguments: `{ prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" }`

### `teach`

Meta-learning: teach procedures, draft procedure definitions, learn from examples, and execute stored workflows. Procedures are composed from existing tools; they are not independent generated MCP tools unless promoted through Evolve's generated-tool lifecycle.

Arguments: `{ action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" }`

### `evolve`

Evidence-driven workflow learning and generated-tool lifecycle management. Mines repeated successful bounded workflows, infers parameters, validates procedures, and exposes explicitly approved trial/active generated capabilities as namespaced MCP tools.

Arguments: `{ action: "string (analyze|candidates|inspect|propose|validate|approve|activate_trial|promote|reject|revise|deprecate|feedback|report|cleanup)", id: "string (optional, candidate/generated capability id or name)", proposal: "string (optional, structured JSON proposal for manual propose/revise)", approver: "string (optional)", useful: "boolean (optional, for feedback)", notes: "string (optional)", reason: "string (optional)", limit: "number (optional, logs to analyze)" }`

### `predict`

Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness

Arguments: `{ action: "string (analyze|list|feedback|suggest)", id: "string (optional, prediction id for feedback)", feedback: "boolean (optional, true if useful, false if not)" }`

### `fresheyes`

Get a fresh perspective from Sidekick's LLM (Grok) on a problem. Sends sanitized context for independent analysis

Arguments: `{ problem: "string (problem description)", context: "string (optional, relevant context)", files: "array (optional, files analyzed)", hypotheses: "array (optional, current hypotheses)", full_response: "boolean (optional, return full response vs key insights)" }`

### `respond`

Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed.

Arguments: `{ text: "string (the response text to return)" }`

## Database, knowledge, and optional infrastructure

### SQLite-backed registry and logs

The built-in database tools operate on SQLite by default and can target PostgreSQL where supported with `database: "postgres"`. Read-only query mode is the default for `db_query` and rejects mutating or multi-statement SQL.

Important tools in this group:

- `db_schema`, `db_query`, `db_stats`, `db_backup`, `db_restore`, `db_export`, `db_search`, `db_migrate`, and `db_diff`.
- `log_query` reads the SQLite `tool_logs` table.
- `knowledge` manages the SQLite `knowledge` table used by `AGENTS.md`. `delete` is a soft delete that disables an entry; `purge` physically removes an already-disabled entry.

### Optional services

`redis`, `metrics`, `embed`, `ollama`, `tunnel`, `wireguard`, `nginx`, `ocr`, `media`, `transcribe`, `download`, and `analytics` depend on optional services or binaries installed by `scripts/setup-tools.sh`.

## External integrations and secrets

### `notify`

Send notifications to Discord, Slack, or email

Arguments: `{ channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" }`

### `github`

GitHub API integration (PRs, issues, commits, releases)

Credentials: `github` uses `GITHUB_TOKEN` from the MCP process environment first, then encrypted `secret` key `github_token`. Do not store GitHub tokens in KV storage.

Arguments: `{ action: "string", repo: "string", args: "string (optional)" }`

`args` accepts JSON for structured actions, such as `{"number":28,"method":"merge"}` for `pr_merge` or `{"ref":"<sha>"}` for `commit_status`. Legacy raw values such as `"28"` for PR/issue numbers and `"<sha>"` for commit status are also supported.

`commit_status` reads GitHub's legacy combined commit status endpoint. It does not include GitHub Actions check runs. Use `ci_status` when deciding whether CI is passing.

### `ci_status`

Read-only GitHub CI/check-run inspection for a PR head, commit SHA, ref, or branch.

GitHub has two CI result surfaces: legacy commit statuses and modern check runs. Legacy statuses come from integrations that write status contexts. GitHub Actions and many apps publish check runs. `ci_status` reads both check runs and legacy statuses, paginates results, and aggregates them into `failure`, `pending`, `success`, or `no_checks`.

Credentials: `ci_status` uses `GITHUB_TOKEN` from the MCP process environment first, then encrypted `secret` key `github_token`. Do not store GitHub tokens in KV storage. Required permissions are read-only repository metadata plus commit status/check read access; for private repositories, use a token that can read the repository and checks.

Arguments: `{ repo: "owner/repository", pr: "number (optional)", pull_number: "number (optional)", sha: "string (optional)", commit: "string (optional)", ref: "string (optional)", branch: "string (optional)", format: "text|json (optional, default text)" }`

Provide exactly one selector: `pr`/`pull_number`, `sha`/`commit`, or `ref`/`branch`. For PRs, the tool resolves the PR's `head.sha` and inspects that commit, not the PR merge commit.

Example text calls:

```text
ci_status repo="geoffmcc/sidekick" pr=123
ci_status repo="geoffmcc/sidekick" branch="main"
ci_status repo="geoffmcc/sidekick" sha="abc123..."
```

Example JSON call:

```text
ci_status repo="geoffmcc/sidekick" pr=123 format="json"
```

JSON output includes `repo`, `requested`, resolved `sha`, `overall`, `summary`, `check_runs`, and `statuses` so agents can make decisions without parsing the human-readable text.

### `webhook`

Manage received webhooks (list, get, clear)

Arguments: `{ action: "string", id: "string (optional)", limit: "number (optional)" }`

### `secret`

Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env)

Arguments: `{ action: "string (store|get|delete|list|rotate)", key: "string (secret name)", value: "string (optional, for store)", generate: "string (optional, length for rotate, e.g. '32')" }`

### `security_scan`

Read-only audit for tracked sensitive files, secret signatures, hardcoded credential settings, runtime `.env` safety, and sensitive-file permissions. Findings include paths, key names, line numbers, and severity, but never secret values. The scan obeys Sidekick path policy and skips runtime data, dependencies, tests, and documentation content.

Arguments: `{ path: "string (optional, directory to scan - default Sidekick repo)", max_files: "number (optional, 1-10000 - default 2000)", format: "string (optional, text|json - default text)" }`

### `sandbox`

Execute operations in a tracked context with automatic backup and rollback. Safe experimentation on remote systems.

Arguments: `{ action: "string (exec|rollback|list|diff|clean)", sandbox_name: "string (optional, sandbox identifier)", command: "string (optional, command to execute)", files: "array (optional, files to auto-backup before exec)", auto_backup: "boolean (optional, default true)", rollback_id: "string (optional, sandbox to rollback)" }`

## Automation, scheduling, and orchestration

### `cron`

Schedule recurring tasks (add, list, remove, run jobs)

Arguments: `{ action: "string", name: "string (optional)", schedule: "string (optional)", command: "string (optional)", id: "string (optional)" }`

### `delay`

One-shot task scheduling: run a tool once at a specific time or after a delay

Arguments: `{ action: "string (add|list|cancel|run)", id: "string (optional, for cancel/run)", when: "string (optional, e.g. 10s, 5m, 2h, 1d, or ISO date)", name: "string (optional, human-readable name)", tool: "string (optional, tool name to execute)", args: "object (optional, arguments for the tool)" }`

### `watch`

Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions

Arguments: `{ action: "string (add|list|remove|pause|check)", id: "string (optional, for remove/pause/check)", name: "string (optional, watch name)", source: "string (optional, service|process|endpoint|file)", target: "string (optional, service name, process name, URL, or file path)", condition: "string (optional, e.g. status!=active, not_running, status!=200, content_matches)", interval: "string (optional, e.g. 30s, 5m, 1h)", action_tool: "string (optional, tool to call when triggered)", action_args: "object (optional, args for action tool)", pause: "boolean (optional, true to pause, false to resume)" }`

### `queue`

Persistent task queue with priorities

Arguments: `{ action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" }`

### `retry`

Retry tool calls with exponential backoff

Arguments: `{ tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" }`

### `orchestrate`

Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress

Arguments: `{ action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" }`

### `batch`

Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch.

Arguments: `{ calls: "array (array of { tool: string, args: object })" }`

### `circuit`

Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down.

Arguments: `{ action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" }`

### `runbook`

Operational runbook executor with autonomous and guided modes. Supports verification, rollback, and step-by-step execution.

Arguments: `{ action: "string (create|start|next|verify|rollback|abort|list|get|delete)", name: "string (optional, runbook name)", mode: "string (optional, autonomous|guided - default autonomous)", steps: "array (optional, step definitions)", runbook_id: "string (optional, instance or definition ID)", step_index: "number (optional, step index)" }`

### `ops`

Packaged Sidekick operations workflows for deploy verification, restart smoke tests, deployments, and incident snapshots.

Arguments: `{ action: "string (verify_deployed_commit|restart_and_smoke_test|deploy_current_main|incident_snapshot)", repo_path: "string (optional, must be /home/sidekick/sidekick for deploy workflows)", restart_mcp: "boolean (optional, schedule sidekick-mcp restart for restart_and_smoke_test)" }`

Actions:

- `verify_deployed_commit`: verifies `/home/sidekick/sidekick` is a clean `main` checkout of the expected read-only GitHub repository, confirms the push URL is `DISABLED`, fetches `origin/main`, compares `HEAD` to `origin/main`, and checks Sidekick services.
- `restart_and_smoke_test`: restarts dashboard and agent, checks MCP health, and can schedule an MCP self-restart after the response with `restart_mcp: true`.
- `deploy_current_main`: deploys only `origin/main` in `/home/sidekick/sidekick`, refuses dirty, staged, ahead, diverged, wrong-branch, wrong-origin, credentialed-origin, or push-enabled states, uses a deployment lock, fast-forwards only, installs production dependencies, seeds knowledge, restarts required services, and schedules MCP restart after the response.
- `incident_snapshot`: captures services, resource status, git state, top processes, and recent service logs in one report.

### `mission`

Mission Control intent router for Sidekick operations. Profiles, routes, preflights, and executes common intents through safer existing tools before raw shell.

Arguments: `{ action: "string (profiles|route|preflight|execute - default route)", intent: "string", profile: "string (read_only_audit|trusted_vps|production|danger_zone)", confirm: "boolean (required true for mutation)", key: "string (optional)", project: "string (optional)", query: "string (optional)", repo_path: "string (optional)" }`

Profiles:

- `read_only_audit`: inspection only.
- `trusted_vps`: trusted single-operator host; deploy and key deletion require confirmation.
- `production`: blocks direct deploy and requires confirmation for mutation.
- `danger_zone`: explicit high-power mode; deploy and key deletion require confirmation.

## Data processing and document utilities

### `transform`

Data manipulation pipeline: filter, extract, sort, format, and map data

Arguments: `{ action: "string (filter|extract|sort|format|map)", input: "string", pattern: "string (optional, for filter)", field: "string (optional, for extract)", key: "string (optional, for sort/map)", value: "string (optional, for map)", format: "string (optional, for format: json|csv|table|text)" }`

### `parse`

Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection

Arguments: `{ input: "string (data to parse)", format: "string (optional, json|yaml|xml|ini|csv - auto-detected if not specified)" }`

### `diff`

Semantic comparison of text, JSON, or YAML with structure-aware diffing

Arguments: `{ old_text: "string (original content)", new_text: "string (modified content)", type: "string (optional, text|json|yaml|auto - default auto)", format: "string (optional, unified|summary|json - default unified)" }`

### `hash`

Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification

Arguments: `{ input: "string (optional, data to hash)", path: "string (optional, file path to hash)", algorithm: "string (optional, md5|sha1|sha256|sha512 - default sha256)", verify: "string (optional, expected hash to verify against)" }`

### `validate`

Validate data against JSON Schema

Arguments: `{ data: "string|object (data to validate)", schema: "string|object (JSON Schema)" }`

### `template`

Render Handlebars templates with data

Arguments: `{ template: "string (Handlebars template)", data: "string|object (template data)" }`

### `cache`

Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL.

Arguments: `{ action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" }`

### `extract`

Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need.

Arguments: `{ path: "string (file path)", fields: "string|array (optional, field paths to extract e.g. 'database.host,database.port')" }`

### `anonymize`

Replace sensitive data with realistic but fake values. Preserves data structure while making it safe to share externally.

Arguments: `{ action: "string (anonymize|patterns|add_pattern|remove_pattern)", input: "string (optional, text to anonymize)", format: "string (optional, text|json|yaml - default text)", custom_patterns: "array (optional, {pattern, replacement} objects)", consistency: "boolean (optional, same input always maps to same output - default true)" }`

### `changelog`

Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries.

Arguments: `{ action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" }`

## Monitoring, diagnostics, and operations

### `health`

Composite system health checks with scoring and issue detection

Arguments: `{ check: "string (all|services|processes|disk|network|custom)", services: "string (optional, comma-separated service names)", commands: "string (optional, comma-separated commands for custom check)", threshold: "string (optional, e.g. 'disk>90,mem>80')" }`

### `snapshot`

Capture system state and detect drift by comparing snapshots

Arguments: `{ action: "string (capture|compare|list|delete)", name: "string (snapshot name)", capture: "string (optional, comma-separated: processes,services,disk,packages,network,files:/path)", compare: "string (optional, baseline snapshot name for compare action)" }`

### `summarize`

Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats.

Arguments: `{ path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" }`

### `filter`

Filter file contents or directory listings by pattern, date, or size before returning.

Arguments: `{ path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" }`

### `tail`

Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file.

Arguments: `{ source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" }`

### `diff_files`

Compare two files directly without reading both into context. Returns unified diff or summary.

Arguments: `{ path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" }`

### `find`

Advanced file finder: search by name pattern, date range, size range, and content pattern.

Arguments: `{ path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" }`

### `status`

Unified system status: services, disk, memory, load, uptime, top processes in one call.

Arguments: `{ include: "string (optional, comma-separated: services,disk,memory,load,uptime,processes - default services,disk)", services: "string (optional, comma-separated service names - default sidekick-mcp,sidekick-dashboard,sidekick-agent)" }`

### `netdiag`

Unified network diagnostics: DNS, routing, port scanning, connectivity checks, and local listeners.

Arguments: `{ action: "string (check|dns|route|ports|listeners|connectivity)", target: "string (host, URL, or IP to diagnose)", port_range: "string (optional, port range e.g. '80-443')", timeout: "number (optional, timeout in ms - default 5000)", format: "string (optional, detailed|compact|json - default detailed)" }`

### `timeline`

Build chronological timeline from multiple log sources. Correlates events across log.jsonl, journalctl, git, and file modifications.

Arguments: `{ action: "string (build|filter|export)", since: "string (start time: ISO or relative like 1h, 1d)", until: "string (optional, end time - default now)", sources: "array (optional, log.jsonl|journalctl|git|files|all - default all)", pattern: "string (optional, regex filter)", severity: "string (optional, error|warn|info|all - default all)", format: "string (optional, compact|detailed|json - default compact)", max_events: "number (optional, default 200)" }`

### `baseline`

Behavioral baseline and anomaly detection. Learns normal patterns and detects statistical deviations.

Arguments: `{ action: "string (record|learn|check|status|reset)", metric_name: "string (metric identifier)", value: "number (optional, value to record)", source: "string (optional, health|custom|command)", command: "string (optional, command to collect metric)", window: "string (optional, history window - default 7d)", sensitivity: "string (optional, low|medium|high - default medium)" }`

### `depend`

Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis.

Arguments: `{ action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" }`

### `black_box`

Incident time capsule: captures full system context (services, processes, logs, disk, network) in one call for debugging. Rate limited.

Arguments: `{ action: "string (capture|list|get|delete|analyze)", name: "string (optional, incident name)", include: "array (optional, services|processes|logs|disk|network|all - default all)", analyze_with_llm: "boolean (optional, use LLM for analysis - default false)", incident_id: "string (optional, incident ID)" }`


## Dispatcher behavior

All agent-side tool calls should go through `callTool(name, args)`. The dispatcher looks up the handler in `TOOLS`, records start time, executes the handler, logs success/failure through `logToolCall`, and returns a normalized MCP-style result.

Unknown tool names return an error result instead of throwing. Exceptions inside handlers are caught, logged, and converted to an error result.

## Redaction behavior

Tool output is passed through `redactSensitive` in many handlers before being returned or logged. This is intended to prevent accidental leakage of private keys, tokens, passwords, and similar material. Redaction is a safety layer, not a substitute for avoiding dangerous commands or overbroad file reads.
