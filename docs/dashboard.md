# Dashboard

The dashboard bootstrap/composition is implemented in `src/dashboard.js` and defaults to port 4098. Coherent route families are registered from `src/dashboard/`, including authentication/identity, approvals, KV, system, logs, connectors, quick actions, statistics/tools, and summary routes. It serves a browser UI plus JSON endpoints for logs, KV data, system status, service status, tool metadata, webhook capture, and agent task proxying.

## Main UI areas

The dashboard frontend is split across `src/dashboard.html`, `static/dashboard.css`, and `static/dashboard.js`. `src/dashboard.js` serves the private HTML shell from the authenticated root route and serves only CSS/JS/font assets through `/static`. The UI is organized around tabs for Mission Control, system status, activity, data, database, configuration, agent tasks, memory, tools, capabilities, Compute, and metrics. Approvals are surfaced from Mission Control when pending.

Typical dashboard functions:

- use Mission Control as the default LAN portal for service health, attention items, quick actions, tool traffic, and recent activity;
- view recent tool calls from the `tool_logs` table;
- browse and edit KV entries;
- inspect and manage structured memories;
- view system statistics;
- inspect configured tools;
- manage capability packs (install, configure, enable, disable, upgrade, uninstall, health);
- submit autonomous agent tasks;
- stream agent progress;
- view task history;
- inspect enrolled Compute workers, jobs, leases, and job artifacts;
- inspect and resolve pending approvals and ambiguous executions;
- receive and inspect external webhook payloads;
- clear logs, KV data, conversations, or all dashboard-managed data.

### Agent sessions

The Agent tab presents a logical session assembled from immutable Agent task
transcripts. Each turn remains its own governed task with its own execution
identity, lineage, checkpoint/work state, evidence, approvals, and completion
outcome. **New Agent Task** creates a new root; **Send follow-up** creates a
validated child of the latest terminal leaf through the canonical continuation
endpoint.

History is a bounded, newest-first session summary ordered by canonical
transcript timestamps. Legacy records without valid timestamps use filesystem
modification time as an explicit fallback; malformed records are isolated.
Session details load on selection, while browser storage keeps only the active
root/task identifiers. Progress is an allowlisted projection of per-task work
state and never includes hidden reasoning, raw checkpoint state, or approval
authority. Browser reload reattaches to a live stream where supported; process
restart behavior follows durable recovery/checkpoint semantics and is not
presented as a fabricated resume.

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

## Capabilities

The Capabilities tab is the operator surface for capability packs
(`docs/capability-packs.md`). It shows:

- **Installed packs** — name, display name, version, publisher, provenance
  (first-party/third-party), whether the pack is bundled, lifecycle state,
  derived health, and the modules, tools, workflows and knowledge assets the
  pack contributes. Actions: Details, Health Check, Enable, Disable, Upgrade,
  Uninstall.
- **Available bundled packs** — first-party packs shipped with this release
  that are not installed, with Inspect and Install. An incompatible pack shows
  the Sidekick range it requires and its Install button is disabled.
- **Local package inspection/installation** — a server-local path can be
  inspected or installed. Paths resolve on the Sidekick server; the browser
  cannot browse server files, and there is no remote marketplace in v1.

Endpoints:

| Route | Purpose |
|---|---|
| `GET /api/capabilities` | installed packs plus available bundled packs |
| `GET /api/capabilities/:name` | full pack description |
| `GET /api/capabilities/:name/health` | derived component health |
| `GET /api/capabilities/:name/workflows` | the pack's workflow definitions |
| `POST /api/capabilities/inspect` | inspect a bundled pack or server-local path |
| `POST /api/capabilities/install` | install a bundled pack or server-local path |
| `POST /api/capabilities/:name/configure` | validate and persist configuration |
| `POST /api/capabilities/:name/enable` | activate owned components |
| `POST /api/capabilities/:name/disable` | withdraw active capabilities |
| `POST /api/capabilities/:name/upgrade` | upgrade from a bundled or local package |
| `POST /api/capabilities/:name/uninstall` | remove the pack |

**Every mutation dispatches the governed `capability` tool server-side**
through `callDashboardTool`, so pack operations carry the same policy,
approval, redaction and audit path as an MCP call. Browser code never mutates
pack state directly. The dashboard's existing Basic Auth/session cookie, IP
allowlist, rate limiting and Origin-based CSRF checks all apply, and each
mutation is written to the dashboard audit log. Failures are surfaced verbatim:
incompatible version, bad package, hash mismatch, invalid entry point, missing
dependency, invalid configuration, descriptor collision, module load failure,
unhealthy component and restart requirement each report their own reason.

Installing or enabling a pack activates executable module code inside the
Sidekick process; the page says so, and destructive actions confirm first.

## Mission Control Quick Actions

Mission Control includes authenticated quick actions backed by `POST /api/quick-actions/:action`. The first actions are health check, recent failures, deployment info, MCP service logs, and sidekick-agent restart. Service log and restart actions are restricted to explicit service allowlists.

## Metrics

The Metrics tab embeds Grafana through the authenticated dashboard under `/grafana/*`; it does not require enabling anonymous Grafana access. The dashboard proxy authenticates to the local Grafana service with `SIDEKICK_GRAFANA_ADMIN_USER` (default `sidekick`) and `SIDEKICK_GRAFANA_ADMIN_PASSWORD`.

Metrics collection is handled by `sidekick-metrics.timer`, which runs `scripts/collect-metrics.js` every minute with `/home/sidekick/sidekick/.env` loaded. The timer writes to InfluxDB using `SIDEKICK_INFLUX_*` settings.

## Data editing

`GET /api/kv` returns the KV store. `PUT /api/kv/:key` writes or updates one KV entry. `DELETE /api/kv/:key` removes one key. KV entries may be stored as simple legacy strings or as metadata objects with `value`, `project`, `category`, `source`, `created`, and `updated` fields.

## Webhook capture

`POST /api/webhook/:source` stores a webhook payload with a generated ID, source name, timestamp, and body. Webhook storage is backed by the `webhooks` document in the SQLite `json_documents` table.

Use `webhook` to list, retrieve, or clear stored webhook payloads from the MCP side.

## Agent proxy

The dashboard forwards agent routes to the Agent Bridge on `SIDEKICK_AGENT_PORT`:

- submit a task;
- stream Server-Sent Events for task progress;
- read task history;
- read a specific task transcript.

The dashboard is therefore the normal browser entry point for the autonomous agent even though the actual runner is a separate process.
