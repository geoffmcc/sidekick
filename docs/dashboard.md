# Dashboard

The dashboard is implemented in `src/dashboard.js` and defaults to port 4098. It serves a browser UI plus JSON endpoints for logs, KV data, system status, service status, tool metadata, webhook capture, and agent task proxying.

## Main UI areas

The dashboard frontend is split across `src/dashboard.html`, `static/dashboard.css`, and `static/dashboard.js`. `src/dashboard.js` serves the private HTML shell from the authenticated root route and serves only CSS/JS/font assets through `/static`. The UI is organized around tabs for system status, activity, data, configuration, agent tasks, and tools.

Typical dashboard functions:

- view recent tool calls from the `tool_logs` table;
- browse and edit KV entries;
- view system statistics;
- inspect configured tools;
- submit autonomous agent tasks;
- stream agent progress;
- view task history;
- receive and inspect external webhook payloads;
- clear logs, KV data, conversations, or all dashboard-managed data.

## Authentication and protections

Dashboard Basic Auth is enabled only when both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` are set. When enabled, it protects the dashboard HTML, JSON APIs, and agent event streams. Static assets remain public so authenticated browsers can load CSS and fonts. The dashboard also supports `SIDEKICK_DASHBOARD_ALLOWED_IPS`, in-memory rate limiting, origin checks for mutating requests, audit logging, and frontend error logging.

If the dashboard is exposed outside a private network, put it behind a reverse proxy, VPN, or additional authentication. For shared deployments, also set `SIDEKICK_TOOL_POLICY=restricted`.

## Tool catalog

`GET /api/tools` returns tool metadata for the dashboard, including risk classification and whether the active dashboard policy enables each tool. The Tools tab displays that policy state alongside search, category filtering, and argument details.

## Data editing

`GET /api/kv` returns the KV store. `PUT /api/kv/:key` writes or updates one KV entry. `DELETE /api/kv/:key` removes one key. KV entries may be stored as simple legacy strings or as metadata objects with `value`, `project`, `category`, `source`, `created`, and `updated` fields.

## Webhook capture

`POST /api/webhook/:source` stores a webhook payload with a generated ID, source name, timestamp, and body. Webhook storage is backed by the `webhooks` document in the SQLite `json_documents` table.

Use `sidekick_webhook` to list, retrieve, or clear stored webhook payloads from the MCP side.

## Agent proxy

The dashboard forwards agent routes to the Agent Bridge on `SIDEKICK_AGENT_PORT`:

- submit a task;
- stream Server-Sent Events for task progress;
- read task history;
- read a specific task transcript.

The dashboard is therefore the normal browser entry point for the autonomous agent even though the actual runner is a separate process.
