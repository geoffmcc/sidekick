# Sidekick: Database-First Remote Agent Platform

## Abstract

Sidekick is a self-hosted remote agent platform built around the Model Context Protocol (MCP). It gives opencode and other MCP clients access to a long-lived remote machine with persistent memory, a searchable knowledge base, a database-backed tool registry, a browser dashboard, and an autonomous Agent Bridge.

The current architecture is database-first. SQLite is the runtime source of truth for key-value memory, tool logs, named JSON documents, tool metadata, tool categories, and the knowledge base. `AGENTS.md` remains the activation layer: it tells agents how to connect and where to query, but it intentionally points agents into the database instead of trying to carry all documentation in prompt-loaded markdown.

## 1. Design Goals

Sidekick is optimized for a trusted operator who wants an AI assistant to keep continuity across sessions and operate a remote machine. The goals are:

- Provide one MCP endpoint that exposes operational tools to opencode.
- Keep project knowledge and instructions durable across AI sessions.
- Make current tool metadata queryable without reading source files.
- Let operators inspect and manage the system through a dashboard.
- Allow autonomous multi-step work through a local Agent Bridge.
- Preserve a small, direct Node.js service model with no build step.
- Keep deployment practical on a VPS, VM, home server, mini PC, or Raspberry Pi.

Sidekick is not a generic chatbot. It is remote administrative capability with an AI-facing interface.

## 2. Runtime Components

Sidekick runs as three primary Node.js services:

| Service | Entry point | Default bind | Role |
|---|---|---|---|
| MCP Server | `src/index.js` | `0.0.0.0:4097` | Public MCP endpoint for tool discovery and tool calls. |
| Dashboard | `src/dashboard.js` | `0.0.0.0:4098` | Browser UI, management API, database browser, tool catalog, and agent proxy. |
| Agent Bridge | `src/agent.js` | `127.0.0.1:4099` | Autonomous task loop that plans tool calls and streams progress. |

Node.js 22 or newer is required. The core runtime dependencies are Express, the MCP SDK, Zod, better-sqlite3, PostgreSQL and Redis clients, and parsers for structured formats.

Optional supporting services include Redis, PostgreSQL, Qdrant, InfluxDB, Grafana, Ollama, Docker, ffmpeg, ImageMagick, Tesseract OCR, Whisper, yt-dlp, Cloudflare tunnels, WireGuard, and Nginx. These are installed by optional setup flows and are used only by the tools that need them.

## 3. Activation Model

The key integration point is `AGENTS.md`. opencode reads this file at session startup. `AGENTS.md` tells the assistant:

- where the MCP server is;
- how to query the knowledge base;
- how to query the tool catalog;
- which dashboard, agent, and SSH endpoints exist;
- what to do if the needed information is not found.

The important design choice is that `AGENTS.md` is not the main documentation body. It is a database access guide. The agent should query SQLite through Sidekick tools, then fall back to markdown only when editing docs or when no database entry exists.

## 4. Agent Information Access Model

This is the "secret sauce" of the current setup.

The database file is resolved by `src/db.js`:

- `SIDEKICK_DB_FILE` when set.
- Otherwise `SIDEKICK_DATA_DIR/sidekick.db`.
- In the standard deployment: `/home/sidekick/sidekick/data/sidekick.db`.

Agents should use these access paths:

| Information need | Tool path | SQLite location |
|---|---|---|
| Documentation, policies, best practices, architecture, protocols, operations | `sidekick_knowledge` | `knowledge` |
| Broad tool overview, grouped manifest, capability search | `sidekick_tools` | `tools`, `tool_categories`, `tool_category_map` |
| Exact tool list, descriptions, args, risk, enabled/deprecated state | `sidekick_db_query database="sqlite"` | `tools`, `tool_categories`, `tool_category_map` |
| Project memory and stored facts | `sidekick_store`, `sidekick_get`, `sidekick_delete`, `sidekick_list_projects`, `sidekick_get_by_project` | `kv_store` |
| Structured memories and task continuity | `sidekick_context`, `sidekick_project`, or SQL | `memories` plus compatibility entries in `json_documents.context` |
| Structured feature state | feature tools or SQL | `json_documents` |
| Tool call history | `sidekick_log_query` or SQL | `tool_logs` |
| Schema and migration status | `sidekick_db_schema`, `sidekick_db_migrate` | `meta` plus migration files |

Default retrieval order:

1. Query `sidekick_knowledge` for the topic.
2. Query the tool registry tables for exact tool metadata.
3. Query KV/context/structured memory state for project-specific continuity.
4. Use source markdown only when authoring docs or resolving a missing/stale database entry.

The practical result is token efficiency and lower drift. The agent does not need to reread large files to answer common operational questions, and the tool catalog reflects the currently running code after startup sync.

## 5. SQLite Data Layer

`src/db.js` owns the SQLite database. It creates the data and backup directories, opens the database through `better-sqlite3`, and enables:

- WAL journal mode;
- normal synchronous mode;
- foreign keys;
- a busy timeout.

The initial schema creates:

- `meta`
- `kv_store`
- `json_documents`
- `tool_logs`

The second migration adds:

- `tool_categories`
- `tools`
- `tool_category_map`
- `knowledge`

The third migration adds:

- `memories`

Later migrations extend `memories` with lifecycle, sync, and deferred-review fields:

- `004_memory_lifecycle.sql`: confirmation timestamps, expiry indexes, and decay support.
- `005_sync_support.sql`: origin machine/user identifiers, sync versioning, and last-sync timestamps.
- `006_memory_deferred.sql`: state, confirmation requirements, confirmer identity, soft delete, and expiration timestamps.

The `meta` table stores `schema_version`. Migration files live in `migrations/` and use numeric prefixes such as `001_initial_schema.sql` through `006_memory_deferred.sql`.

On MCP startup, `src/index.js` calls:

1. `dbStore.runPendingMigrations()`
2. `syncToolRegistry()`

This means schema and tool metadata are brought current before the server begins handling normal tool traffic.

## 6. Core Tables

### `kv_store`

`kv_store` stores durable key-value memory. Rows include the key, JSON-encoded value metadata, project, source, and timestamps.

The value JSON preserves a compatibility shape:

```json
{
  "value": "stored text",
  "project": "sidekick",
  "category": "config",
  "source": "mcp",
  "created": "2026-06-16T00:00:00.000Z",
  "updated": "2026-06-16T00:00:00.000Z"
}
```

`sidekick_get` returns only the value for backward compatibility. `sidekick_delete` removes one KV entry by key. Project filtering is provided by `sidekick_get_by_project`.

### `json_documents`

`json_documents` stores named JSON blobs. It is used for simple structured state such as:

- `cron`
- `webhooks`
- `context`
- `watches`

Some constants in code still have old file names for compatibility and readability, but the active load/save path for these documents is `dbStore.loadDocument()` and `dbStore.setDocument()`.

The `context` document remains a compatibility and session-continuity store. It contains explicit `sidekick_context` entries for projects, decisions, problems, patterns, and sessions, plus mirrored automatic memory summaries. The first-class queryable store for automatic memory is now the `memories` table.

### `memories`

`memories` stores structured memory rows. Each row has a memory type, project, content, summary, tags, confidence, source metadata, enabled state, automatic flag, confirmation count, lifecycle state, sync metadata, timestamps, and optional expiry.

Initial automatic memory writes produce:

- `session` rows for completed Agent Bridge tasks;
- `tool_call` rows for useful tool calls.

The extraction pass can also emit `fact`, `decision`, `preference`, `open_thread`, and `observation` rows from agent task text when the content clearly matches those patterns.

Repeated equivalent memories update the existing row and increment `times_confirmed`. When a new extracted memory is similar enough to an existing active row but not identical, the older row is superseded and disabled with replacement metadata. High-value memories can require confirmation, memories can be soft-deleted, expired, restored, exported/imported, and synced between machines with conflict strategies. Recall uses the structured table first, can merge semantic Qdrant matches when embeddings are available, then merges compatibility entries from the `context` document.

### `tool_logs`

`tool_logs` stores redacted activity entries for tool calls. Each row records timestamp, tool name, argument summary, duration, success, summary, source, and the original compact JSON entry.

This table powers:

- dashboard activity views;
- `sidekick_log_query`;
- metrics collection;
- operational analysis of recent tool behavior.

Retention is controlled by `SIDEKICK_MAX_LOG`.

### `tools`, `tool_categories`, and `tool_category_map`

These tables are the database-backed tool registry. The registry is synced from `TOOL_DEFS`, `TOOL_RISK`, and `TOOL_CATEGORIES` in `src/tools.js`.

The `tools` table contains:

- name;
- description;
- argument JSON;
- risk;
- enabled;
- deprecated;
- version/documentation metadata fields;
- update timestamp.

The MCP server marks code-removed tools as deprecated instead of deleting them, preserving history and making drift explicit.

### `knowledge`

`knowledge` stores documentation and operational knowledge. Each entry has category, title, content, tags, enabled status, version metadata, and update timestamp.

`sidekick_knowledge` supports:

- `search`
- `get`
- `list`
- `add`
- `update`
- `delete`

Current search is a SQLite `LIKE` search across title, content, and tags. It is intentionally simple and robust. Semantic search can be layered through Qdrant-backed context tools where needed, but the knowledge base itself is plain SQLite.

## 7. Tool System

The current code exports 94 built-in `sidekick_*` tools. A built-in tool has six relevant parts:

1. An async handler in `src/tools.js`.
2. A `TOOLS` map entry.
3. A `TOOL_DEFS` metadata entry.
4. A Zod schema in `TOOL_SCHEMAS` in `src/index.js`.
5. A category mapping in `TOOL_CATEGORIES`.
6. A risk label in `TOOL_RISK`, or default `low`.

The tool categories currently include:

- Core
- Storage
- Database
- Git & GitHub
- Services
- Scheduling
- Communication
- Context & Learning
- Data Pipeline
- Monitoring
- Workflow
- Meta
- Efficiency
- Security
- Networking
- Development
- Reliability
- Archive
- Media

Tool policy is source-aware. `getToolDefsForSource(source)` reads tool metadata from the database, applies policy for the source, and returns each tool with `risk`, `enabled`, and `policy` fields.

Sources include:

- `mcp`
- `dashboard`
- `agent`
- `unknown`

## 8. MCP Server

`src/index.js` builds MCP server instances with `@modelcontextprotocol/sdk`. It supports:

- Streamable HTTP at `/mcp`;
- legacy SSE at `/sse` and `/messages`;
- diagnostics at `/health`.

The MCP routes require a bearer token or `api_key` query parameter. `SIDEKICK_ALLOWED_IPS` can restrict remote access by IP or CIDR. Localhost remains allowed.

The server maintains in-memory sessions. Each session includes:

- MCP server instance;
- transport;
- creation timestamp;
- last access timestamp;
- initialization state;
- user agent/client metadata.

Inactive sessions are cleaned up after 1 hour. Stale Streamable HTTP sessions receive a structured JSON-RPC error and a replacement session ID header so clients can reinitialize cleanly.

## 9. Dashboard

`src/dashboard.js` serves:

- `src/dashboard.html`;
- static CSS/JS/assets;
- status APIs;
- database APIs;
- KV APIs;
- tool and category APIs;
- knowledge/procedure read APIs;
- webhook receiver;
- agent proxy routes.

The dashboard reads the same SQLite-backed storage as the MCP server. Its database tab can inspect schema, run read-only SQL by default, search tables, view migration status, and create backups.

Dashboard protections include:

- optional Basic Auth;
- optional IP allowlist;
- in-memory rate limiting;
- JSON body size limit;
- same-origin checks for mutating requests;
- audit logging for state-changing operations;
- frontend error logging;
- tool-policy enforcement around risky dashboard-triggered DB operations.

The dashboard proxies agent routes to the Agent Bridge on localhost, so operators normally access autonomous tasks through the dashboard even though the runner is a separate process.

## 10. Agent Bridge

`src/agent.js` runs an autonomous goal loop. It is intentionally bound to `127.0.0.1` by default and is meant to be reached through the dashboard proxy.

Task lifecycle:

1. Client submits a goal to `POST /api/agent/run`.
2. The bridge creates a task ID and emits progress through SSE.
3. The bridge builds a system prompt from policy-filtered tool definitions.
4. The LLM returns either a tool call JSON object, a thought, or a completion object.
5. Valid tool calls are executed through `callTool`.
6. Results are fed back into the conversation loop.
7. The loop ends on `done`, error, or `SIDEKICK_MAX_ITERATIONS`.
8. A transcript is written to `data/conversations/<taskId>.json`.

Current LLM behavior in `agent.js` is code-truth specific:

- The agent tries local Ollama first.
- If Ollama fails and `GROQ_API_KEY` is set, it falls back to Groq.
- It emits provider and fallback events to the stream.
- It detects installed Ollama models and prefers coding models such as `qwen2.5-coder`, then general models, then a fallback.

The `sidekick_llm` tool has its own provider selection behavior and can use `SIDEKICK_DEFAULT_LLM`.

The Agent Bridge also loads and executes:

- one-shot delays created by `sidekick_delay`;
- recurring watches created by `sidekick_watch`.

## 11. Persistence Files Outside SQLite

SQLite is the primary state store, but file artifacts remain where appropriate:

- `data/conversations/*.json`: agent transcripts.
- `data/procedures.json`: learned procedures dynamically registered as tools after restart.
- `data/secrets.enc`: encrypted secrets managed by `sidekick_secret`.
- `data/audit.jsonl`: dashboard mutation audit log.
- `data/dashboard-errors.log`: dashboard/frontend error log.
- snapshots, queues, evolve proposals, orchestrations, predictions, health history, circuits, baselines, runbooks, black-box captures, sandbox metadata, and anonymization patterns.

The rule of thumb for new features is:

- use SQLite tables for shared queryable state;
- use `json_documents` for named structured state;
- use files for artifacts, exports, encrypted blobs, transcripts, or bundles.

## 12. Optional Infrastructure

Sidekick can use additional services when installed:

- PostgreSQL for `sidekick_db_*` tools with `database="postgres"`.
- Redis for `sidekick_redis` and cache workflows.
- Qdrant for semantic context search.
- InfluxDB for metrics.
- Grafana for dashboards.
- Ollama for local model inference and embeddings.
- Docker for optional service wrappers.
- ffmpeg/ImageMagick/Tesseract/Whisper/yt-dlp for media tools.
- WireGuard, Nginx, and Cloudflare tunnels for network tools.

The optional services are not required for the core MCP, dashboard, SQLite, or knowledge-base workflows.

## 13. Metrics and Monitoring

Metrics collection is handled by `scripts/collect-metrics.js` and the `sidekick_metrics` tool. The script reads:

- system metrics;
- tool usage from SQLite `tool_logs`;
- service status;
- Docker stats when available;
- optional Ollama metrics.

It writes to InfluxDB using:

- `SIDEKICK_INFLUX_URL`
- `SIDEKICK_INFLUX_TOKEN`
- `SIDEKICK_INFLUX_ORG`
- `SIDEKICK_INFLUX_BUCKET`

Grafana provisioning lives under `grafana/` and includes dashboards for overview, tool analytics, system health, database performance, Docker containers, and Ollama metrics.

## 14. Deployment Model

The repo provides:

- `deploy.ps1` for Windows operators;
- `deploy.sh` for Linux/macOS operators;
- `scripts/bootstrap.sh` for first-host setup;
- `systemd/` units for services;
- `docker/docker-compose.yml` for optional infrastructure.

The standard remote path is:

```bash
/home/sidekick/sidekick
```

The primary systemd units are:

```bash
sidekick-mcp
sidekick-dashboard
sidekick-agent
```

Optional infrastructure units include:

```bash
sidekick-postgres
sidekick-redis
sidekick-qdrant
sidekick-influxdb
sidekick-grafana
```

## 15. Security Model

Sidekick should be treated like remote shell access to the host. Its safety model is defense in depth, not a claim that powerful tools are harmless.

Core protections:

- MCP bearer token authentication.
- Optional MCP IP allowlist.
- Dashboard Basic Auth.
- Optional dashboard IP allowlist.
- Constant-time comparison for secrets.
- Tool output redaction.
- Dangerous shell command blocklist.
- Read-only SQL by default.
- Tool policy with global and source-specific allow/block lists.
- Restricted sudoers file for the `sidekick` user.
- Dashboard CSRF origin checks for mutating methods.
- Dashboard rate limiting and request size limits.

Tool policy is controlled with:

- `SIDEKICK_TOOL_POLICY`
- `SIDEKICK_BLOCKED_TOOLS`
- `SIDEKICK_ALLOWED_TOOLS`
- `SIDEKICK_MCP_TOOL_POLICY`
- `SIDEKICK_DASHBOARD_TOOL_POLICY`
- `SIDEKICK_AGENT_TOOL_POLICY`
- source-specific allow/block list variables.

In `restricted` mode, high and critical tools are blocked unless explicitly allowed. Explicit blocklists win.

## 16. Development Workflow

Adding a built-in tool requires coordinated updates:

1. Add handler in `src/tools.js`.
2. Add to `TOOLS`.
3. Add to `TOOL_DEFS`.
4. Add risk/category metadata in `src/tools.js`.
5. Add Zod schema in `src/index.js`.
6. Add tests.
7. Update docs or knowledge entries.

Because the registry syncs to the database on MCP startup, code metadata becomes queryable through the dashboard and `sidekick_db_query` after restart.

Tests live under `test/` and are run with:

```bash
npm test
```

## 17. Current Trade-Offs

SQLite has replaced the old full-file KV/log bottleneck for core state, but not every feature artifact has moved into the database. This is intentional where files are natural outputs, but shared mutable state should continue moving toward SQLite or another transactional backend.

The knowledge base uses simple SQLite search rather than a complex retrieval stack. This keeps it predictable and easy to operate, but ranking and semantic search are limited.

The Agent Bridge is autonomous but local and bounded. It is useful for delegated tasks, but it is not a second always-on collaborator integrated into the main opencode session.

The tool surface is broad by design. This makes Sidekick powerful for trusted operators, but deployments exposed beyond a private trusted network should use restrictive tool policy, strong credentials, and network controls.

## 18. Summary

Sidekick's current architecture is best understood as a database-backed remote operations layer for AI agents. The markdown files activate and document the system, but the runtime knowledge path is SQLite:

- `knowledge` for docs and operational guidance;
- `tools` and category tables for tool discovery;
- `kv_store` for durable memory;
- `json_documents` for structured feature state;
- `tool_logs` for activity history.

This database-first model is what lets agents recover context, inspect current capabilities, and operate consistently across sessions without loading large markdown files into every prompt.
