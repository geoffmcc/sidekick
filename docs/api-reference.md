# HTTP API Reference

This reference is generated from Express route declarations in `src/index.js`, `src/dashboard.js`, and `src/agent.js`.

## Route inventory

| Source | Method | Path | Notes |
|---|---|---|---|
| `src/index.js` | GET | `/health` | |
| `src/index.js` | GET | `/sse` | |
| `src/index.js` | POST | `/messages` | |
| `src/index.js` | POST | `/mcp` | |
| `src/index.js` | GET | `/mcp` | |
| `src/index.js` | DELETE | `/mcp` | |
| `src/dashboard.js` | GET | `/api/logs` | |
| `src/dashboard.js` | GET | `/api/kv` | |
| `src/dashboard.js` | GET | `/api/system` | |
| `src/dashboard.js` | GET | `/api/dashboard-summary` | |
| `src/dashboard.js` | GET | `/api/llm` | |
| `src/dashboard.js` | GET | `/api/services` | |
| `src/dashboard.js` | GET | `/api/config` | |
| `src/dashboard.js` | PUT | `/api/kv/:key` | |
| `src/dashboard.js` | GET | `/api/kv/projects` | |
| `src/dashboard.js` | DELETE | `/api/kv/:key` | |
| `src/dashboard.js` | GET | `/api/stats` | |
| `src/dashboard.js` | GET | `/api/tools` | |
| `src/dashboard.js` | GET | `/api/tool-categories` | |
| `src/dashboard.js` | GET | `/api/knowledge` | |
| `src/dashboard.js` | GET | `/api/procedures` | |
| `src/dashboard.js` | GET | `/api/memories` | |
| `src/dashboard.js` | GET | `/api/memories/projects` | |
| `src/dashboard.js` | GET | `/api/memories/types` | |
| `src/dashboard.js` | POST | `/api/memories/:id/disable` | |
| `src/dashboard.js` | POST | `/api/memories/:id/enable` | |
| `src/dashboard.js` | DELETE | `/api/memories/:id` | |
| `src/dashboard.js` | POST | `/api/memories/export` | |
| `src/dashboard.js` | POST | `/api/memories/import` | |
| `src/dashboard.js` | GET | `/api/memories/stats` | |
| `src/dashboard.js` | POST | `/api/memories/expire` | |
| `src/dashboard.js` | GET | `/api/sync/identity` | |
| `src/dashboard.js` | POST | `/api/sync/identity` | |
| `src/dashboard.js` | GET | `/api/sync/export` | |
| `src/dashboard.js` | POST | `/api/sync/import` | |
| `src/dashboard.js` | GET | `/api/sync/diff` | |
| `src/dashboard.js` | GET | `/api/db/schema` | |
| `src/dashboard.js` | POST | `/api/db/query` | |
| `src/dashboard.js` | GET | `/api/db/stats` | |
| `src/dashboard.js` | POST | `/api/db/backup` | |
| `src/dashboard.js` | GET | `/api/db/search` | |
| `src/dashboard.js` | GET | `/api/db/migrations` | |
| `src/dashboard.js` | DELETE | `/api/logs` | |
| `src/dashboard.js` | DELETE | `/api/kv` | |
| `src/dashboard.js` | DELETE | `/api/conversations` | |
| `src/dashboard.js` | DELETE | `/api/data` | |
| `src/dashboard.js` | POST | `/api/internal/error-log` | |
| `src/dashboard.js` | POST | `/api/webhook/:source` | |
| `src/dashboard.js` | POST | `/api/agent/run` | |
| `src/dashboard.js` | GET | `/api/agent/stream/:taskId` | |
| `src/dashboard.js` | GET | `/api/agent/history` | |
| `src/dashboard.js` | GET | `/api/agent/run/:id` | |
| `src/dashboard.js` | GET | `/` | |
| `src/agent.js` | POST | `/api/agent/run` | |
| `src/agent.js` | GET | `/api/agent/stream/:taskId` | |
| `src/agent.js` | GET | `/api/agent/history` | |
| `src/agent.js` | GET | `/api/agent/run/:id` | |
| `src/agent.js` | GET | `/api/agent/status` | |
| `src/agent.js` | GET | `/api/health` | |
| `src/agent.js` | POST | `/api/delays/reload` | |
| `src/agent.js` | POST | `/api/watches/reload` | |

## MCP server endpoints

### `GET /health`

Returns JSON health information including uptime, current session count, stale session mappings, version, timestamp, and session details.

### `POST /mcp`

Primary Streamable HTTP MCP endpoint. Requires a valid bearer token or `api_key` query parameter. Handles session creation, tool invocation, and stale session reinitialization responses.

### `GET /mcp`

Streamable HTTP GET path. Requires a valid `mcp-session-id` header.

### `DELETE /mcp`

Streamable HTTP session teardown. Requires a valid `mcp-session-id` header.

### `GET /sse` and `POST /messages`

Legacy SSE transport. `/sse` creates an SSE session. `/messages` posts JSON-RPC messages for the session ID issued by the SSE transport.

## Dashboard API summary

The dashboard API includes read endpoints for logs, KV data, structured memories, sync metadata, system status, dashboard summary, LLM status, services, config, stats, tools, tool categories, knowledge entries, procedures, database schema, database stats, database search, and migration status. `/api/tools` returns risk and policy metadata for each tool. It includes mutating endpoints for KV writes/deletes, memory enable/disable/delete/import/export/expiration, sync identity/import operations, database queries/backups, log/data resets, error logging, webhook capture, and agent proxy operations.

## Agent API summary

The Agent Bridge exposes endpoints for task submission, task event streaming, task history, individual task retrieval, status, health, delay reload, and watch reload.
