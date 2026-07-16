# Architecture

Sidekick is a three-process Node.js application with a shared SQLite database and data directory.

```text
opencode / MCP client
        |
        | Bearer token
        v
MCP Server :4097  ---- loads/registers tools ----> src/tools.js
        |
        | SQLite sidekick.db + selected JSON/JSONL artifacts
        v
Persistent data directory

Browser
        |
        v
Dashboard :4098 ---- proxy ----> Agent Bridge :4099

Agent Bridge :4099 ---- calls ----> src/tools.js
```

## Service boundaries

### MCP server: `src/index.js`

The MCP server creates an `McpServer` from `@modelcontextprotocol/sdk`, registers the Sidekick tool definitions, and serves them over:

- `POST /mcp`, `GET /mcp`, and `DELETE /mcp` for Streamable HTTP;
- `GET /sse` and `POST /messages` for legacy SSE clients;
- `GET /health` for diagnostics.

The server requires `Authorization: Bearer <SIDEKICK_API_KEY>` or `?api_key=<key>` for MCP routes. It can also enforce `SIDEKICK_ALLOWED_IPS`. Tool calls are checked against the active tool policy before execution.

### Tool implementation: `src/tools.js`

The tool module owns most application behavior. It loads configuration, ensures the data directory exists, implements tool handlers, redacts sensitive output, logs tool calls, syncs the tool registry into SQLite, and persists state through the SQLite document layer or tool-specific files.

Important exported values include:

- `TOOLS`: map of tool name to handler function.
- `TOOL_DEFS`: dashboard-facing catalog of tool names, descriptions, and argument summaries.
- `getToolDefsForSource(source)`: policy-aware catalog including risk and enabled status.
- `callTool(name, args)`: central dispatcher used by the agent and wrapper tools; enforces tool policy.
- `syncToolRegistry()`: upserts `TOOL_DEFS` into the database on MCP startup and marks removed tools deprecated.
- `logToolCall(...)`: writes redacted tool activity to the `tool_logs` SQLite table.
- `setSource(source)`: records whether a call came from MCP, dashboard, agent, or another path.

### Evolve and dynamic tools

The Evolve implementation is intentionally split out of the large tool module:

- `src/evolve/analyzer.js` restores chronological log order, segments calls by source/session/task/inactivity gap, rejects retries and failure loops, and mines repeated successful multi-tool workflows.
- `src/evolve/validator.js` validates inferred schemas, referenced tools, recursive parameter substitution, security constraints, and dry-run/mock execution plans.
- `src/evolve/lifecycle.js` owns generated capability state transitions: `observed`, `candidate`, `validated`, `awaiting_approval`, `trial`, `active`, `deprecated`, `rejected`, and `failed_validation`.
- `src/evolve/index.js` implements the `sidekick_evolve` action interface.
- `src/dynamic-tools.js` loads approved trial/active generated capabilities from SQLite, exposes schemas for MCP registration, executes approved procedure steps, and records audit/usefulness counters.

Verified problems in the previous Evolve implementation:

- Tool logs were read newest-first while adjacent entries were interpreted as forward chronological sequences.
- Sequence mining crossed unrelated global logs without source, session, task, project, or inactivity boundaries.
- Analysis used only tool names, not safe argument shape, result summary, success/failure, retries, or generated-call metadata.
- Procedure testing echoed proposal text in a sandbox instead of validating schemas, tool references, substitution, policy, or execution behavior.
- Approved workflow/config proposals had no reliable implementation path; procedure approvals were converted by another LLM prompt and stored behind `sidekick_teach`.
- Generated capabilities were not independent discoverable MCP tools with a stable schema; legacy procedures were only registered as `sidekick_<procedure>` at server construction.
- Documentation and tool descriptions overstated self-extension by calling proposals and procedures generated tools.

The replacement stores generated capabilities and audit history in SQLite. Trial and active capabilities are synced into the normal `tools` registry with names like `sidekick_generated_<descriptive_name>`, registered by the MCP server on startup, and removed from discovery when rejected or deprecated without deleting audit history.

Generated tool invocations also mirror parent and per-step execution state into the additive platform kernel tables (`platform_executions` and `platform_execution_events`). The generated-tool tables remain the compatibility source of truth for existing APIs while the platform records provide the first shared execution graph adapter.

Direct MCP tool calls are mirrored from `logToolCall(...)` into the same platform kernel tables for non-generated tool activity. The legacy `tool_logs` table remains the compatibility source for existing Activity views and Evolve mining while the platform rows provide execution graph correlation.

Black Box captures also mirror capture lifecycle, source progress, and redacted source artifacts into the platform kernel. The Black Box incident/capture/source tables and artifact files remain the compatibility source of truth while `platform_executions`, `platform_execution_events`, and `platform_artifacts` provide shared execution graph visibility.

Dashboard quick actions mirror user-triggered dashboard operations into `platform_executions` with `operation_type='dashboard_action'`. Existing HTTP responses, audit logs, and dashboard behavior remain the compatibility source of truth while platform rows provide shared visibility for UI-initiated actions.

Agent Bridge tasks mirror task lifecycle, tool-call progress, and transcript artifacts into the platform kernel with `operation_type='agent_task'`. Existing agent HTTP APIs, event streams, conversation transcripts, and tool calls remain the compatibility source of truth while platform rows provide shared task visibility.

Memory intelligence operations emit platform events for handoff processing, session lifecycle changes, and explicit remember/correct actions. The memory, handoff, task-session, and audit tables remain the compatibility source of truth while platform events provide cross-subsystem chronology.

Approval requests mirror queue, approval, rejection, expiry, and terminal execution outcomes into the platform kernel with `operation_type='approval_request'`. Encrypted approval payloads and existing approval status remain in `json_documents('approvals')`; platform rows contain only lifecycle metadata and redacted result summaries.

Schedulers and guided operational workflows mirror definitions and execution attempts into the platform kernel. Cron jobs, delays, watches, and runbook instances keep their existing JSON/document stores as compatibility sources of truth while platform executions/events provide shared visibility for queued work, checks, triggers, manual runs, timer-fired background runs, step progress, completion, cancellation, and failures.

### Authoritative execution control: `platformGuard` and `findActiveExecution`

The platform kernel provides guard-first primitives that adapters use before starting or transitioning work:

- `platformGuard(executionId, expectedState, options)` validates an execution exists, is in the expected state, and is not terminal before allowing operations. Without an execution ID, it queries for concurrent active executions by `operation_type`, `tool_name`, `project_id`, or `dedupe_key` and blocks duplicates when `allowConcurrent: false`.
- `findActiveExecution(query)` returns non-terminal executions matching the query filters, enabling adapters to detect overlapping work.
- `TERMINAL_STATES` is exported so adapters can reason about lifecycle boundaries.

Adapters use the guard-first pattern:

- `recordPlatformToolCall` checks for an existing execution before creating a new one, preventing duplicate tool-call records when metadata carries an execution ID.
- `transitionPlatformApproval` validates the execution is not terminal before transitioning, silently returning for already-terminal approvals.
- `createScheduledPlatformExecution` checks for concurrent active executions of the same operation type before creating new schedule/delay/watch/runbook records.
- `transitionScheduledPlatformExecution` validates the execution is not terminal before transitioning.

Guard failures never block tool execution — they prevent platform state divergence. The kernel continues to validate transitions at the database level via `ALLOWED_TRANSITIONS`, and the guard adds pre-flight checks that adapters use to avoid redundant or conflicting state changes.

### Dashboard: `src/dashboard.js`

The dashboard serves a browser UI and JSON API. The server code lives in `src/dashboard.js`, the authenticated HTML shell lives in `src/dashboard.html`, and public CSS/JS assets live under `static/`. It reads the Sidekick data directory, reports system state, allows KV editing and deletion, exposes tool metadata, accepts webhooks, and proxies agent requests to the Agent Bridge.

It includes dashboard-specific protections: optional Basic Auth, IP allowlist, rate limiting, exact-host CSRF origin checks, audit logging, error logging, and policy-aware tool metadata.

The dashboard separates adjacent data domains instead of rendering every store as a raw event log:

- Activity shows what Sidekick did from `tool_logs`. `/api/logs` returns normalized raw calls plus session summaries. Sessions use real session/task identifiers when present; otherwise a deterministic source-plus-time-window fallback keeps legacy records grouped without inventing unsupported relationships.
- Data shows what Sidekick stores from `kv_store`. `/api/kv` derives namespace, type, size, preview, project/source metadata, and compact totals. The UI inspector renders structured JSON, plain text, and Markdown-like text safely. KV history is not shown because the backend stores only the current value.
- Memory shows what Sidekick learned from `memories`. The dashboard categorizes rows as durable, sessions, unresolved, or operational; existing `tool_call` memories stay readable under Operational instead of dominating the default view.

Dashboard-rendered arguments, outputs, KV values, and memory content are escaped in the browser. The API shaping layer applies the existing redaction rules to activity details and KV previews, and destructive KV/memory actions continue to use confirmation flows plus backend authorization checks.

### Agent Bridge: `src/agent.js`

The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`, and streams progress events. It also loads scheduled delays and watches at startup.

The agent has a loop limit controlled by `SIDEKICK_MAX_ITERATIONS` and stores transcripts under `data/conversations/`. Before planning it builds a compact memory brief from structured memories and semantic recall when available. Its prompt is filtered through the active `agent` tool policy so blocked tools are not offered for planning.

## Session handling

The MCP server tracks sessions in memory. Sessions include the MCP server instance, transport, creation time, last access time, and initialization state. Inactive sessions are removed after 1 hour. Streamable HTTP GET and DELETE require a valid `mcp-session-id` header. Stale POST sessions return a structured JSON-RPC error and a replacement session ID header so the client can reinitialize.

## Shared storage

All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example deployment. Core KV, structured memories, tool logs, generated Evolve capabilities, generated-tool audit history, tool catalog data, knowledge base entries, and named JSON documents are stored in SQLite (`sidekick.db`). Some feature-specific artifacts still use files: agent transcripts, audit/error logs, secrets, snapshots, queues, runbooks, baselines, and similar operational bundles.

Back up both `sidekick.db` and the surrounding data directory. Keep logs trimmed, protect backups as sensitive operational data, and avoid using the KV store as a large application database.
