# HTTP API Reference

## MCP Server API

Default base URL:

```text
http://<host>:4097
```

Authentication is required for all routes except `/health`.

### `GET /health`

Returns process and session health information.

Response fields include:

- `status`
- `uptime`
- `uptimeHuman`
- `sessions`
- `sessionDetails`
- `staleMappings`
- `version`
- `timestamp`

### `POST /mcp`

Streamable HTTP MCP request endpoint. Used by MCP clients for initialization and tool calls. Uses `mcp-session-id` headers for session continuity.

### `GET /mcp`

Streamable HTTP GET endpoint. Requires a valid `mcp-session-id` header.

### `DELETE /mcp`

Deletes a valid MCP session and forwards the DELETE request through the active transport.

### `GET /sse`

Legacy SSE endpoint for clients that use `SSEServerTransport`.

### `POST /messages?sessionId=<id>`

Legacy SSE message endpoint. Requires a valid SSE session ID.

## Dashboard API

Default base URL:

```text
http://<host>:4098
```

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/logs?limit=100` | none | Return recent tool logs. |
| GET | `/api/kv` | none | Return all KV entries. |
| PUT | `/api/kv/:key` | JSON entry data | Create or update a KV entry. |
| DELETE | `/api/kv/:key` | none | Delete a KV entry. |
| GET | `/api/kv/projects` | none | Return project counts. |
| GET | `/api/system` | none | Return system metrics. |
| GET | `/api/llm` | none | Return LLM status/configuration summary. |
| GET | `/api/services` | none | Return service statuses. |
| GET | `/api/config` | none | Return dashboard-safe config summary. |
| GET | `/api/tools` | none | Return the full tool catalog (name, description, args). |
| GET | `/api/stats` | none | Return summary stats. |
| DELETE | `/api/logs` | none | Clear tool logs. |
| DELETE | `/api/kv` | none | Reset KV storage. |
| DELETE | `/api/conversations` | none | Delete agent transcripts. |
| DELETE | `/api/data` | none | Clear logs, KV, and conversations. |
| POST | `/api/internal/error-log` | error payload | Append dashboard error log entry. |
| POST | `/api/webhook/:source` | any JSON | Store webhook payload. |
| POST | `/api/agent/run` | `{ "goal": "..." }` | Proxy task start to the agent bridge. |
| GET | `/api/agent/stream/:taskId` | none | Proxy task event stream. |
| GET | `/api/agent/history` | none | Proxy recent agent history. |
| GET | `/api/agent/run/:id` | none | Proxy one saved transcript. |

## Agent Bridge API

Default base URL:

```text
http://127.0.0.1:4099
```

The bridge is loopback-bound and intended to be accessed by the dashboard.

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/agent/run` | `{ "goal": "..." }` | Start an autonomous task and return `taskId`. |
| GET | `/api/agent/stream/:taskId` | none | Stream task events as Server-Sent Events. |
| GET | `/api/agent/history` | none | Return up to 20 recent transcripts. |
| GET | `/api/agent/run/:id` | none | Return a saved transcript. |
| GET | `/api/health` | none | Return `{ "ok": true }`. |
| POST | `/api/delays/reload` | none | Reload pending delays. |
| POST | `/api/watches/reload` | none | Reload active watches. |

## Server-Sent Event Payloads

Agent event payloads are JSON objects written as SSE `data:` lines. Common event forms include:

```json
{ "type": "step", "text": "Analyzing task..." }
```

```json
{ "type": "tool", "tool": "sidekick_bash", "summary": "..." }
```

```json
{ "type": "error", "text": "..." }
```

```json
{ "type": "done", "text": "..." }
```
