# Sidekick Documentation

Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs describe the current source tree and migrations, while runtime operational knowledge lives in the SQLite-backed knowledge base.

The project currently exposes three core Node.js services and 107 built-in MCP tools across 20 categories. Approved trial/active generated capabilities may add runtime tools beyond that built-in count. Tool metadata, categories, risk labels, enabled/deprecated state, tool logs, key-value data, structured memories, and the knowledge base are stored in SQLite.

The tool execution boundary is modular and authoritative under `src/tools/`, but most established handlers still live in `src/tools-legacy.js` behind compatibility adapters while family-by-family extraction continues. See `tool-architecture.md` for the full migration disclosure.

## Agent Information Access

The important runtime pattern is database-first access. `AGENTS.md` is the thin instruction layer that tells agents where to look; the authoritative operational content is in SQLite.

| Need | Primary access path | Backing location |
|---|---|---|
| Documentation, architecture, operations, protocols, best practices | `knowledge` | `knowledge` table |
| Broad tool overview, grouped manifest, capability search | `tools` | `tools`, `tool_categories`, `tool_category_map` |
| Exact tool list, args, category, risk, enabled/deprecated state | `db_query database="sqlite"` | `tools`, `tool_categories`, `tool_category_map` |
| Persistent project facts | `store`, `get`, `delete`, `get_by_project` | `kv_store` |
| Structured memories, task summaries, facts, preferences, decisions, open threads, observations | `context`, `project`, or SQL | `memories`, plus compatibility data in `json_documents.context` |
| Structured feature documents | Feature tools or `db_query` | `json_documents` |
| Recent tool activity | `log_query` | `tool_logs` |

The database file is `SIDEKICK_DB_FILE` when set, otherwise `SIDEKICK_DATA_DIR/sidekick.db`. In the standard deployment that resolves to `/home/sidekick/sidekick/data/sidekick.db`.

Fresh databases can be manually seeded with current Sidekick self-knowledge:

```bash
cd /home/sidekick/sidekick
sqlite3 data/sidekick.db < docs/knowledge-seed.sql
```

The deploy scripts also run `npm run seed:knowledge` after dependencies install. That script imports the same seed only when the `knowledge` table has zero enabled rows, so existing deployments are preserved. If your database already has knowledge entries and you want to add or refresh the packaged Sidekick seed, run:

```bash
npm run seed:knowledge -- --force
```

`--force` only replaces rows whose `version_added` is `seed-2026-06-16-current`; it does not delete user-authored knowledge entries. Verify the seed with:

```bash
sqlite3 data/sidekick.db "SELECT COUNT(*) FROM knowledge WHERE version_added = 'seed-2026-06-16-current';"
```

## Documentation map

| File | Purpose |
|---|---|
| `overview.md` | What Sidekick is, how the pieces fit together, and common use cases. |
| `architecture.md` | Service boundaries, request flow, storage layout, sessions, and process model. |
| `installation.md` | Fresh install, deployment scripts, manual systemd setup, and MCP client configuration. |
| `configuration.md` | Environment variables, ports, LLM settings, data directory, and auth settings. |
| `compute.md` | Sidekick Compute architecture, worker protocol, artifacts, cancellation, tests, and non-goals. |
| `tools-reference.md` | Complete tool inventory generated from the built-in tool registry. |
| `tool-architecture.md` | Built-in tool descriptor, registry, dispatcher, policy, and compatibility architecture. |
| `tool-usage-guide.md` | Practical usage patterns and examples for important tool groups. |
| `dashboard.md` | Dashboard UI, API routes, webhooks, data editing, reset endpoints, and agent proxy. |
| `agent-bridge.md` | Autonomous task runner behavior, task history, streaming, delays, and watches. |
| `data-model.md` | SQLite schema, JSON document storage, remaining file-backed state, backups, and migrations. |
| `security.md` | Authentication, IP allowlists, redaction, command safety, dashboard protections, and risk notes. |
| `predict.md` | Predict evidence sources, lifecycle, confidence behavior, privacy boundaries, and tests. |
| `operations.md` | Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. |
| `development.md` | Source layout, testing, extension workflow, and implementation notes. |
| `api-reference.md` | HTTP endpoint reference for MCP, Dashboard, and Agent services. |
| `knowledge-seed.sql` | Manual SQL seed for populating a fresh `knowledge` table with Sidekick self-knowledge. |

## Runtime services

| Service | Default port | Entry point | Purpose |
|---|---:|---|---|
| MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. |
| Dashboard | 4098 | `src/dashboard.js` | Browser UI and management API for logs, KV data, config, tools, and agent tasks. |
| Agent Bridge | 4099 | `src/agent.js` | Local API for autonomous task execution, task streaming, delayed jobs, and watches. |
| Ollama | 11434 | external | Optional local LLM provider. |
| Compute worker | outbound to 4097 | `src/compute/worker-agent.js` | Optional enrolled worker process for allowlisted model jobs. |

## Fast path

```bash
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick
cp .env.example .env
npm install
node src/index.js
```

Node.js 22 or newer is required. For a persistent deployment, use the supplied deployment scripts or install the three systemd units under `systemd/`.
