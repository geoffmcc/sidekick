# Dashboard

The dashboard is implemented in `src/dashboard.js` and defaults to port 4098. It serves a browser UI plus JSON endpoints for logs, KV data, system status, service status, tool metadata, webhook capture, and agent task proxying.

## Main UI areas

The dashboard frontend is embedded directly in `dashboard.js`. It is organized around tabs for system status, activity, data, configuration, agent tasks, and tools.

Typical dashboard functions:

- view recent tool calls from `log.jsonl`;
- browse and edit KV entries;
- view system statistics;
- inspect configured tools;
- submit autonomous agent tasks;
- stream agent progress;
- view task history;
- receive and inspect external webhook payloads;
- clear logs, KV data, conversations, or all data files.

## Authentication and protections

Dashboard Basic Auth is enabled only when both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` are set. The dashboard also supports `SIDEKICK_DASHBOARD_ALLOWED_IPS`, in-memory rate limiting, origin checks for mutating requests, audit logging, and frontend error logging.

The root page is intentionally allowed through Basic Auth middleware in the current code, while API routes are protected when auth is configured. If the dashboard is exposed outside a private network, put it behind a reverse proxy, VPN, or additional authentication.

## Data editing

`GET /api/kv` returns the KV store. `PUT /api/kv/:key` writes or updates one KV entry. `DELETE /api/kv/:key` removes one key. KV entries may be stored as simple legacy strings or as metadata objects with `value`, `project`, `category`, `source`, `created`, and `updated` fields.

## Webhook capture

`POST /api/webhook/:source` stores a webhook payload with a generated ID, source name, timestamp, headers, query string, and body. Webhook storage is backed by `webhooks.json`.

Use `sidekick_webhook` to list, retrieve, or clear stored webhook payloads from the MCP side.

## Agent proxy

The dashboard forwards agent routes to the Agent Bridge on `SIDEKICK_AGENT_PORT`:

- submit a task;
- stream Server-Sent Events for task progress;
- read task history;
- read a specific task transcript.

The dashboard is therefore the normal browser entry point for the autonomous agent even though the actual runner is a separate process.
