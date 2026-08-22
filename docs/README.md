# Sidekick Documentation

Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs describe the current source tree and migrations, while runtime operational knowledge lives in the SQLite-backed knowledge base.

The project currently exposes three core Node.js services and a dynamically discovered MCP tool catalog across 20 categories. Core, module, capability-pack, and approved generated tools share one registry; the live `tools` manifest is authoritative for metadata, categories, risk labels, enabled/deprecated state, and current counts. Tool logs, key-value data, structured memories, and the knowledge base are stored in SQLite.

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
| `local-deployment.md` | Full local/npx topology, stdio configuration, persistence, CLI, security, Compute, and troubleshooting. |
| `releasing.md` | Maintainer release checklist, signed tags, GitHub Releases, and pinned npx consumption. |
| `install.md` | Documentation conventions (server path, IP placeholder) and deploy-script quick reference. |
| `configuration.md` | Environment variables, ports, LLM settings, data directory, and auth settings. |
| `operations.md` | Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. |
| `ollama.md` | Local Ollama model setup. |
| `dashboard.md` | Dashboard UI, API routes, approvals/reconciliation, webhooks, and agent proxy. |
| `security.md` | Authentication, IP allowlists, redaction, command safety, tool policy, path policy, approvals. |
| `identity.md` | Core principal model and first-run Owner foundation. |

**Capability documentation** — what Sidekick can do:

| File | Purpose |
|---|---|
| `tools-reference.md` | Tool reference and argument guide; the live registry is authoritative because modules, capability packs, and approved generated tools can change the inventory. |
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
| `browser-automation.md` | Governed Browser Automation: the Core Chromium subsystem, the `browser` tool, egress policy, isolation, secrets, artifacts, and the runtime install step. |
| `container-operations-pack.md` | Container Operations (Docker / Podman): engine profiles, bounded inspection, Compose validation, updates, lifecycle safety, and limitations. |
| `workspace-secret-references.md` | Encrypted workspace secret storage at the kernel boundary. |

### Additional references

These documents are maintained references or historical/design records that are
useful for focused work but are not part of the primary reading path above:

| File | Purpose |
|---|---|
| `capability-packs.md` | Capability-pack lifecycle, trust boundaries, installation, configuration, and contributed content. |
| `developer-pack.md` | Developer / Software Engineering pack tools and workflows. |
| `jellyfin-pack.md` | Jellyfin integration and maintenance workflows. |
| `network-firewall-operations-pack.md` | Governed network and firewall operations pack. |
| `proxmox-pack.md` | Proxmox VE profiles, guest operations, provisioning, and retirement. |
| `security-research-pack.md` | Security Research pack scope, evidence, workspace, and report boundaries. |
| `third-party-capability-packs.md` | Authoring and review guidance for compatible third-party packs. |
| `transcription.md` | Current transcription support and its Compute boundary. |
| `privacy.md` | Runtime privacy policy and data-handling boundaries. |
| `handoff-v2.md` | Handoff versioning and resume-packet design notes. |
| `security-hardening-phase-20.md` | Security hardening status and remaining work. |
| `archive/security-audits/security-phase-01-threat-model.md` | Historical threat model and trust-boundary review. |
| `archive/security-audits/security-phase-02-dispatch-boundary.md` | Historical dispatcher and execution-boundary review. |
| `archive/security-audits/security-phase-03-auth-authorization.md` | Historical authentication and authorization review. |
| `archive/security-audits/security-phase-04-secure-defaults.md` | Historical secure-defaults review. |
| `archive/security-audits/security-phase-05-subprocess-shell.md` | Historical subprocess and shell safety review. |
| `archive/security-audits/security-phase-06-filesystem-data.md` | Historical filesystem and data-boundary review. |
| `archive/security-audits/security-phase-07-secrets-redaction.md` | Historical secrets and redaction review. |
| `archive/security-audits/security-phase-08-http-network.md` | Historical HTTP and network-boundary review. |
| `archive/security-audits/security-phase-09-dashboard-web.md` | Historical dashboard and web-surface review. |
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
| `dispatcher-identity-recovery-plan.md` | Dispatcher identity/approval-recovery plan (implemented). |

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
