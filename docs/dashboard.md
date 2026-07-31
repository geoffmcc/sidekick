# Dashboard

The dashboard is implemented in `src/dashboard.js` and defaults to port 4098. It serves a browser UI plus JSON endpoints for logs, KV data, system status, service status, tool metadata, webhook capture, and agent task proxying.

## Main UI areas

The dashboard frontend is split across `src/dashboard.html`, `static/dashboard.css`, and `static/dashboard.js`. `src/dashboard.js` serves the private HTML shell from the authenticated root route and serves only CSS/JS/font assets through `/static`. The UI is organized around tabs for Mission Control, system status, activity, data, database, configuration, agent tasks, memory, tools, and metrics.

Typical dashboard functions:

- use Mission Control as the default LAN portal for service health, attention items, quick actions, tool traffic, and recent activity;
- view recent tool calls from the `tool_logs` table;
- browse and edit KV entries;
- inspect and manage structured memories;
- view system statistics;
- inspect configured tools;
- submit autonomous agent tasks;
- stream agent progress;
- view task history;
- receive and inspect external webhook payloads;
- clear logs, KV data, conversations, or all dashboard-managed data.

## Approvals and reconciliation

The Approvals tab lists both standalone approvals and those raised by a Brain task. The two behave differently, and the difference is deliberate:

- **Arguments are rendered on demand for task-originated approvals.** They are stored encrypted and no redacted preview is persisted, so the card shows a **Show arguments** control that calls `GET /api/approvals/:id/preview`. The server decrypts, verifies the payload against its digest, and redacts at render time; nothing is cached or written back. If the payload does not match its digest the control reports it as tampered rather than displaying it — the reviewer is the control that catches a substituted action, so they must never be shown a forgery.
- **Approving a task-originated request does not execute it.** It marks the task runnable; the task runner executes the step and the result flows back into the task. Rejecting it resumes the task with a structured refusal instead of leaving it parked.
- **Reconciliation** appears as an **Ambiguous Executions** section on the same page, shown only when something is waiting. It handles a high-risk step whose execution is ambiguous after a crash: a runner claimed the step and stopped before recording a result, so whether the tool ran is genuinely unknown — which is why no outcome was recorded and why nothing resumes it automatically.

  Four decisions are offered. **It ran** records the step completed without re-running the tool. **It did not run** renews the authorization and redispatches once — it is styled as destructive and requires an explicit confirmation, because asserting an effect did not land when it did causes it to happen twice, which is audited but not verifiable. **Give up on this step** records a refusal and lets the plan continue. **Fail the task** stops it entirely.

  Resolving requires an authenticated principal and refuses outright when dashboard authentication is not configured — an unattributed reconciliation is worse than none — and in that case the section says so instead of rendering controls that would be refused. Backed by `GET /api/reconciliations` and `POST /api/reconciliations/:taskId/resolve`.

The approving identity recorded against an approval is the authenticated dashboard user. When authentication is not configured, the record says `unattributed:dashboard` rather than naming a reviewer who does not exist.

## Authentication and protections

Dashboard Basic Auth is enabled only when both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` are set. When enabled, it protects the dashboard HTML, JSON APIs, and agent event streams. Static assets remain public so authenticated browsers can load CSS and fonts. The dashboard also supports `SIDEKICK_DASHBOARD_ALLOWED_IPS`, in-memory rate limiting, origin checks for mutating requests, audit logging, and frontend error logging.

If the dashboard is exposed outside a private network, put it behind a reverse proxy, VPN, or additional authentication. For shared deployments, also set `SIDEKICK_TOOL_POLICY=restricted`.

## Tool catalog

`GET /api/tools` returns tool metadata for the dashboard, including risk classification and whether the active dashboard policy enables each tool. The Tools tab displays that policy state alongside search, category filtering, and argument details.

## Mission Control Quick Actions

Mission Control includes authenticated quick actions backed by `POST /api/quick-actions/:action`. The first actions are health check, recent failures, deployment info, MCP service logs, and sidekick-agent restart. Service log and restart actions are restricted to explicit service allowlists.

## Metrics

The Metrics tab embeds Grafana through the authenticated dashboard under `/grafana/*`; it does not require enabling anonymous Grafana access. The dashboard proxy authenticates to the local Grafana service with `SIDEKICK_GRAFANA_ADMIN_USER` (default `sidekick`) and `SIDEKICK_GRAFANA_ADMIN_PASSWORD`.

Metrics collection is handled by `sidekick-metrics.timer`, which runs `scripts/collect-metrics.js` every minute with `/home/sidekick/sidekick/.env` loaded. The timer writes to InfluxDB using `SIDEKICK_INFLUX_*` settings.

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
