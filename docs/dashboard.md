# Dashboard

The dashboard is implemented in `src/dashboard.js` and listens on `SIDEKICK_DASHBOARD_PORT`, default `4098`.

## Purpose

The dashboard provides a browser interface and JSON API for observing and managing Sidekick. It reads and writes the same data directory used by the MCP tools.

Main responsibilities:

- Show recent tool call logs.
- Browse and edit KV storage.
- Display system, service, and LLM status.
- Clear logs, KV data, conversations, or all operational data.
- Receive and store external webhooks.
- Proxy agent bridge task submission, event streaming, and history reads.
- Log dashboard-side frontend/API errors.

## Startup KV Seeding

On startup, the dashboard seeds missing system keys into `kvstore.json`. These include server, network, service, security, software, deployment, and configuration metadata. Existing keys are not overwritten.

Examples of seeded key groups:

- `server:*`
- `network:*`
- `services:*`
- `security:*`
- `software:*`
- `deploy:*`
- `config:*`

Seeded entries use project `system` and source `dashboard`.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/logs` | Return recent tool call log entries from `log.jsonl`. Query `limit` is capped at 500. |
| GET | `/api/kv` | Return KV entries in normalized array form. |
| PUT | `/api/kv/:key` | Create or update a KV entry. State-changing operation is audit logged. |
| DELETE | `/api/kv/:key` | Delete one KV entry. State-changing operation is audit logged. |
| GET | `/api/kv/projects` | Return project names and counts. |
| GET | `/api/system` | Return uptime, memory, disk, CPU, load, and network information. |
| GET | `/api/llm` | Return LLM configuration/status summary. |
| GET | `/api/services` | Return service status for known Sidekick services. |
| GET | `/api/config` | Return public configuration summary. |
| GET | `/api/stats` | Return dashboard summary statistics. |
| DELETE | `/api/logs` | Clear `log.jsonl`. |
| DELETE | `/api/kv` | Reset `kvstore.json` to an empty object. |
| DELETE | `/api/conversations` | Delete saved agent conversation transcripts. |
| DELETE | `/api/data` | Clear logs, reset KV, and clear conversations. |
| POST | `/api/internal/error-log` | Append frontend/API error information to `dashboard-errors.log`. |
| POST | `/api/webhook/:source` | Store an external webhook payload in `webhooks.json`. |
| POST | `/api/agent/run` | Proxy task submission to the agent bridge. |
| GET | `/api/agent/stream/:taskId` | Proxy the agent bridge Server-Sent Events stream. |
| GET | `/api/agent/history` | Proxy agent run history. |
| GET | `/api/agent/run/:id` | Proxy a saved agent run transcript. |
| GET | `/` | Serve the dashboard HTML UI. |

## Webhook Storage

The dashboard stores webhook payloads in `webhooks.json`. Each webhook receives an ID, source, timestamp, headers, query object, and payload. The list is capped in code to prevent unbounded growth.

`sidekick_webhook` can list, retrieve, and clear those stored webhook records.

## Agent Proxying

The dashboard proxies agent endpoints to the agent bridge on `127.0.0.1:<SIDEKICK_AGENT_PORT>`. This keeps the bridge private while still allowing browser-based task execution.

## Security Middleware

The dashboard includes:

- Optional IP allowlist with loopback always allowed.
- In-memory rate limiting of 200 requests per 15 minutes per IP.
- JSON request body limit of 1 MB.
- Content-Length rejection above 1 MB.
- Origin checking for state-changing requests.
- Optional HTTP Basic authentication.
- Audit logging for state-changing operations.

The event-stream endpoint for agent streaming bypasses Basic authentication in the dashboard code to avoid breaking SSE clients. Protect the dashboard with network-level restrictions when deployed publicly.
