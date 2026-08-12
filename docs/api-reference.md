# HTTP API Reference

This reference is generated from Express route declarations in `src/index.js`, `src/dashboard.js`, and `src/agent.js` (verified at `5e4dbfd`). Dashboard routes sit behind the dashboard protections described in `security.md`; MCP and compute routes use the authentication described below.

## MCP server (`src/index.js`, port 4097)

### Core endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Diagnostics: uptime, session counts, version. |
| POST | `/mcp` | Primary Streamable HTTP MCP endpoint (bearer token or `api_key`). |
| GET | `/mcp` | Streamable HTTP GET path (requires `mcp-session-id`). |
| DELETE | `/mcp` | Session teardown (requires `mcp-session-id`). |
| GET | `/sse` | Legacy SSE transport session creation. |
| POST | `/messages` | Legacy SSE JSON-RPC message channel. |

### Sidekick Compute routes

Three authenticated route groups are mounted as routers, plus explicitly authenticated flat compatibility aliases:

| Group | Auth | Purpose |
|---|---|---|
| `/compute/enrollment/*` | one-time enrollment token (rate limited) | Worker enrollment exchange. |
| `/compute/worker/*` | scoped worker credential | Worker protocol: heartbeat, capabilities, credential rotation, job claim/start/renew/progress/complete/fail, cancellation check/ack, artifact upload/finalize. |
| `/compute/admin/*` | Sidekick API key | Admin: enrollment tokens, job create/list/get/cancel, recovery, health. |

Flat aliases (all explicitly authenticated, kept for compatibility): `POST /compute/enrollment-tokens`, `POST /compute/enroll`, `POST /compute/heartbeat`, `POST /compute/capabilities`, `POST /compute/credentials/rotate`, `POST /compute/jobs`, `GET /compute/jobs`, `GET /compute/jobs/:jobId`, `POST /compute/jobs/:jobId/cancel`, `POST /compute/jobs/claim`, `POST /compute/jobs/:jobId/start|renew|progress|complete|fail`, `POST /compute/jobs/:jobId/cancellation`, `POST /compute/jobs/:jobId/cancellation/ack`, `POST /compute/jobs/:jobId/artifacts/upload`, `POST /compute/jobs/:jobId/artifacts/:artifactId/finalize`, `POST /compute/recover`, `GET /compute/health`.

## Dashboard (`src/dashboard.js`, port 4098)

### System, config, and catalog

`GET /` (HTML shell), `GET /api/system`, `GET /api/dashboard-summary`, `GET /api/llm`, `GET /api/services`, `GET /api/config`, `GET /api/stats`, `GET /api/tools`, `GET /api/tool-categories`, `GET /api/tool-policy`, `GET /api/knowledge`, `GET /api/procedures`, `GET /api/metrics/status`.

### Activity, KV data, and resets

`GET /api/logs`, `DELETE /api/logs`, `GET /api/kv`, `GET /api/kv/projects`, `PUT /api/kv/:key`, `DELETE /api/kv/:key`, `DELETE /api/kv`, `DELETE /api/conversations`, `DELETE /api/data`, `POST /api/internal/error-log`, `POST /api/webhook/:source`.

### Memory and sync

`GET /api/memories`, `GET /api/memories/projects`, `GET /api/memories/types`, `GET /api/memories/stats`, `GET /api/memories/:id/evidence`, `POST /api/memories/:id/disable`, `POST /api/memories/:id/enable`, `DELETE /api/memories/:id`, `POST /api/memories/export`, `POST /api/memories/import`, `POST /api/memories/expire`, `GET /api/handoffs`, `GET /api/handoffs/:id`, `GET/POST /api/sync/identity`, `GET /api/sync/export`, `POST /api/sync/import`, `GET /api/sync/diff`.

### Database

`GET /api/db/schema`, `POST /api/db/query` (routed through the governed dashboard tool path), `GET /api/db/stats`, `POST /api/db/backup`, `GET /api/db/search`, `GET /api/db/migrations`.

### Approvals and reconciliation

`GET /api/approvals`, `GET /api/approvals/:id/preview` (authenticated on-demand argument rendering), `POST /api/approvals/:id/approve`, `POST /api/approvals/:id/reject`, `GET /api/reconciliations`, `POST /api/reconciliations/:taskId/resolve` (requires an authenticated human principal).

### Evolve and Predict

`GET /api/evolve`, `POST /api/evolve/analyze`, `POST /api/evolve/:id/validate|approve|reject|promote|deprecate|feedback|run`, `GET /api/evolve/executions`, `GET /api/evolve/executions/:executionId`, `GET /api/evolve/executions/:executionId/stream`, `POST /api/evolve/executions/:executionId/cancel`, `GET /api/predict`, `GET /api/predict/status`, `GET /api/predict/:id`, `GET /api/predict/:id/explain`, `POST /api/predict/analyze`, `POST /api/predict/:id/dismiss|feedback|outcome`, `POST /api/predict/migrate`, `GET /api/predict/maintenance/diagnose`, `GET /api/predict/maintenance/purge-preview`, `POST /api/predict/maintenance/purge`.

### Black Box

`GET /api/blackbox/health|profiles|storage|incidents|search|compare|purge-preview`, `GET /api/blackbox/incidents/:id`, `GET /api/blackbox/incidents/:id/timeline|export`, `DELETE /api/blackbox/incidents/:id`, `POST /api/blackbox/incidents/:id/analyze|notes`, `POST /api/blackbox/capture`, `GET /api/blackbox/captures/:id`, `GET /api/blackbox/captures/:id/stream`, `POST /api/blackbox/captures/:id/cancel|retry|repair`, `GET /api/blackbox/sources/:id`, `POST /api/blackbox/purge`.

### Compute (dashboard views)

`GET /api/compute`, `GET /api/compute/workers`, `GET /api/compute/jobs`, `GET /api/compute/jobs/:jobId`, `GET /api/compute/install`, `POST /api/compute/enrollment-tokens`, `POST /api/compute/workers/:workerId/:action` (disable/enable/revoke), `POST /api/compute/jobs/:jobId/:action` (cancel/retry), `POST /api/compute/recover`.

### Platform kernel surfaces (API-only; no dashboard UI yet)

`GET /api/artifacts` (custody metadata only), `GET /api/event-deliveries`, `POST /api/event-subscriptions`, `POST /api/event-subscriptions/:subscriptionId/:action` (pause/resume), `POST /api/event-deliveries/:deliveryId/requeue`, `GET /api/connectors`, `POST /api/connectors`, `GET /api/connectors/:connectorId`, `GET /api/connectors/:connectorId/health|events`, `POST /api/connectors/:connectorId/configure`, `POST /api/connectors/:connectorId/:action` (enable/disable/retire), `GET /api/scope-snapshots`, `POST /api/scope-snapshots`, `POST /api/scope-guard/evaluate`.

Note: creating an event subscription starts delivery fan-out, but no production consumer drains deliveries yet — an active subscription accumulates pending rows until paused (see `platform-convergence-audit.md`).

### Quick actions, Grafana proxy, and agent proxy

`POST /api/quick-actions/:action` (allowlisted Mission Control actions), `/grafana/*` (authenticated proxy to the local Grafana instance for the Metrics tab), plus the agent proxy routes: `POST /api/agent/run`, `POST /api/agent/run/:taskId/follow-up`, `GET /api/agent/stream/:taskId`, `GET /api/agent/history`, `GET /api/agent/run/:id`.

## Agent Bridge (`src/agent.js`, port 4099, loopback-only)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/agent/run` | Submit a task goal. |
| POST | `/api/agent/run/:taskId/follow-up` | Create a child follow-up task continuing a terminal parent. |
| GET | `/api/agent/stream/:taskId` | SSE task progress. |
| GET | `/api/agent/history` | Task history. |
| GET | `/api/agent/run/:id` | Task detail/transcript. |
| GET | `/api/agent/status` | Bridge status. |
| GET | `/api/health` | Health check. |
| POST | `/api/delays/reload` | Reload scheduled delays. |
| POST | `/api/watches/reload` | Reload watches. |

The bridge binds to `127.0.0.1` and has no authentication of its own; it is reached through the authenticated dashboard proxy. See [Agent Bridge → Follow-ups](agent-bridge.md#follow-ups-task-continuation) for the follow-up request/response contract, lineage fields, limits, and security properties.
