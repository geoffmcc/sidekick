# Sidekick Documentation

Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs describe the current source tree and migrations, while runtime operational knowledge lives in the SQLite-backed knowledge base.

The project currently exposes three core Node.js services and 112 built-in MCP tools across 20 categories (106 in the core registry plus 6 from the bundled `data-utilities` module). Approved trial/active generated capabilities may add runtime tools beyond that built-in count. Tool metadata, categories, risk labels, enabled/deprecated state, tool logs, key-value data, structured memories, and the knowledge base are stored in SQLite.

The tool execution boundary is modular and authoritative under `src/tools/`, and handler extraction is complete: every built-in handler is owned by a descriptor family, the `data-utilities` module, or the Compute subsystem, with `src/tools-legacy.js` retaining only policy/approval/audit machinery, ordering anchors, and compatibility exports. See `tool-architecture.md` for the boundary details.

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

**User/operator documentation** — installing, configuring, and running Sidekick:

| File | Purpose |
|---|---|
| `overview.md` | What Sidekick is, how the pieces fit together, and common use cases. |
| `installation.md` | Fresh install, deployment scripts, manual systemd setup, and MCP client configuration. |
| `install.md` | Documentation conventions (server path, IP placeholder) and deploy-script quick reference. |
| `configuration.md` | Environment variables, ports, LLM settings, data directory, and auth settings. |
| `operations.md` | Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. |
| `service.md` | systemd service commands quick reference. |
| `ollama.md` | Local Ollama model setup. |
| `dashboard.md` | Dashboard UI, API routes, approvals/reconciliation, webhooks, and agent proxy. |
| `security.md` | Authentication, IP allowlists, redaction, command safety, tool policy, path policy, approvals. |
| `identity.md` | Core principal model and first-run Owner foundation. |

**Capability documentation** — what Sidekick can do:

| File | Purpose |
|---|---|
| `tools-reference.md` | Complete tool inventory generated from the built-in tool registry. |
| `tool-usage-guide.md` | Practical usage patterns and examples for important tool groups. |
| `agent-bridge.md` | Autonomous task runner behavior, follow-ups, streaming, delays, and watches. |
| `brain.md` | Feature-flagged bounded planner (default off) and approval continuation for parked tasks. |
| `compute.md` | Sidekick Compute architecture, worker protocol, placement, artifacts, cancellation, and non-goals. |
| `compute-worker.md` | Compute worker lifecycle, CLI, credentials, packaging, and OS-service installation. |
| `openvino-npu-worker.md` | OpenVINO NPU/CPU embedding worker architecture and security properties. |
| `blackbox.md` | Black Box incident evidence: profiles, schema, retention, and dashboard behavior. |
| `predict.md` | Predict evidence sources, lifecycle, confidence behavior, privacy boundaries, and tests. |

**Architecture documentation** — how Sidekick works internally:

| File | Purpose |
|---|---|
| `architecture.md` | Service boundaries, request flow, storage layout, sessions, and process model. |
| `tool-architecture.md` | Built-in tool descriptor, registry, dispatcher, policy, and compatibility architecture. |
| `data-model.md` | SQLite schema, JSON document storage, remaining file-backed state, backups, and migrations. |
| `api-reference.md` | HTTP endpoint reference for MCP, Dashboard, and Agent services. |
| `execution-claim-contract.md` | Epoch-fenced execution claims used by the cron/delay/watch/runbook schedulers. |
| `platform-events.md` | Event ledger, transactional fan-out, subscription backlog cap, delivery drainer, and handler registry. |
| `artifact-custody.md` | Kernel artifact custody, compute worker registration, custody failure reporting, and the orphan reconciler. |
| `connectors.md` | Connector authority: managed integrations, credential references, lifecycle, and the GitHub connector. |
| `workspace-secret-references.md` | Encrypted workspace secret storage at the kernel boundary. |
| `adr-approval-continuation.md` | ADR: durable approval continuation for parked tasks (implemented). |
| `adr-brain.md` | ADR: Brain v0.1 orchestration boundary (implemented, feature-flagged). |
| `adr-compute-placement.md` | ADR: shared compute placement decision core (implemented). |
| `adr-openvino-integration.md` | ADR: OpenVINO NPU worker integration (implemented). |

**Convergence and planning documentation** — current campaign state and direction:

| File | Purpose |
|---|---|
| `platform-convergence-audit.md` | Verified capability reality matrix: production-used versus foundation-only, per area. |
| `platform-roadmap.md` | Residual convergence roadmap (tracks A–D) and current next work. |
| `platform-target-architecture.md` | Accepted converged runtime boundaries and dependency directions. |
| `module-system-design.md` | Module contract and lifecycle (activation half implemented; third-party path pending). |
| `security-research-pack.md` | The first-party Security Research capability pack: governed research orchestration over the kernel record layer, with an enforced public/private workspace boundary. |
| `security-research-capability.md` | Earlier design note for the security-research capability (kernel record foundations); superseded in part by the shipped pack in `security-research-pack.md`. |
| `security-research-scope-guard.md` | Scope snapshot and fail-closed target evaluation contract (foundation). |
| `security-research-adapter-contract.md` | Fail-closed external adapter boundary (no verified external transport exists). |
| `structured-memory-plan.md` | Structured memory and memory-intelligence status and remaining steps. |

**Contributor documentation**:

| File | Purpose |
|---|---|
| `development.md` | Source layout, testing, extension workflow, and implementation notes. |
| `tool-creation.md` | Historical tool-creation guide (superseded by `tool-architecture.md`). |
| `technical-paper.md` | Long-form description of the database-first platform design. |
| `knowledge-seed.sql` | Manual SQL seed for populating a fresh `knowledge` table with Sidekick self-knowledge. |

**Historical documents** (preserved as history; not current-state):

| File | Purpose |
|---|---|
| `platform-architecture-assessment.md` | Pre-consolidation assessment (2026-07-15 snapshot). |
| `memory-intelligence-findings.md` | Pre-redesign memory findings (superseded). |
| `dispatcher-identity-recovery-plan.md` | Dispatcher identity/approval-recovery plan (implemented). |
| `project-review.md` | Early project safety review (its follow-ups have since shipped). |
| `workplans/sidekick-compute-completion.md` | Compute completion work plan (completed). |

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
