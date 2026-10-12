# Platform inventory

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

This is a repository snapshot, not a live deployment inventory. No production services, private runtime knowledge, credentials, or operational databases were accessed. The local .env was deliberately not read. Runtime deployment configuration and active/generated tools are unknown.

## Capability map and evidence

| Capability / advertised contract | Implemented entry and authoritative state | Boundaries, recovery, coverage and limits |
| --- | --- | --- |
| MCP and tool discovery | src/index.js -> callMcpTool; src/tools/canonical-registry.js -> registry.js; 110 built-in descriptors materialized in isolated DB | Descriptor schemas, risk and aliases feed dispatcher.js. Modules and generated tools add deployment-dependent tools. Existing tool-registry and dispatcher suites; not every tool executed. |
| Request execution and policy | src/tools/dispatcher.js and context.js; AsyncLocalStorage; core/authentication.js and authorization.js | Source-specific wrappers, schema validation, policy, approvals, resource identity, redaction and logging. Timeout explicitly reports operationMayContinue. Cancellation is cooperative. |
| Agent Bridge | src/agent.js -> agent/task-store.js, receipt-store.js, execution.js, recovery-scan.js | Durable task/receipt records own execution outcomes. Ambiguous mutations require evidence before retry. Handoff adapter is continuity, not execution authority. Recovery tests exist; worker/process failure coverage remains incomplete in this audit. |
| Project identity and work | core/project-identity.js; platform/kernel.js; agent task project/workspace references | Multiple projections still exist: platform projects, memory project strings, resume JSON and task state. Cross-projection reconciliation needs deeper testing. |
| Sessions, handoffs and resumes | tools/families/memory-session.js, memory-handoff.js, resume.js; db/handoff-store.js; memory_handoffs + versions/events/links/evidence_state | Existing v3 contract, optimistic packet versioning, claims, readiness, preflight and session finalization. resume JSON is a discovery pointer. Confirmed defects are tracked in backlog. |
| Memory/context/knowledge | db/memory-domain.js, db/memory-maintenance.js; brain and context-engine modules; knowledge descriptor; migrations 074/075/079 | Typed memory, extraction provenance, maintenance and FTS exist. Retrieval ranking, stale facts and cross-project guarantees require additional evaluation; extracted prose is not verified execution evidence. |
| Workflows and scheduling | workflows/runner.js -> governed dispatch; tools/scheduled-execution.js; agent/delay-*, watch-*; platform execution/step records | Claim leases, stored steps, approval waits and recovery. No blanket exactly-once guarantee. DST, retry storms and event duplicates not evaluated here. |
| Events and audit | platform/event-delivery.js, event-drainer.js, kernel.js; db/tool-logs.js; blackbox.js | Durable event delivery and redacted tool logs; handoff journal hash chain. Failed checkpoint journal transaction reproduced. Other journal/mutation atomicity requires review. |
| Persistence and migrations | src/db.js SQLite WAL; migrations/001..079; optional pg.js, qdrant.js and Redis tools | synchronous=NORMAL; transactions protect logical atomicity, not guaranteed last-commit durability after power failure. Migrations not run on real data. |
| Shell/files/Git/network | descriptor families filesystem, shell, development, net-fetch; tools/path-policy.js; security/child-process.js | Dedicated path, command and outbound controls. Arbitrary command tools remain high trust. Checkpoint status alone fails to detect content drift. |
| Distributed compute | compute/worker-manager.js, job-manager.js, placement.js, inference-service.js, provider-http.js; worker-agent.js | Enrollment, credentials, bounded jobs, placement and cancellation use compute stores. Live disappearance, malicious worker and overload behavior not tested here. |
| Capability packs/modules | packs/lifecycle.js, manifest.js, packaging.js; modules/loader.js and services.js | Component ownership, compatibility, permission comparison and package integrity. Enabled code runs in-process, not in a sandbox. Generated docs/compatibility-pack-inventory.json is the separate bundled catalog. |
| Dashboard/API/CLI | src/dashboard.js -> callDashboardTool; src/cli.js; Agent HTTP and MCP interfaces | Independent authentication/identity transport boundaries. Dashboard UI is a projection; alternate-interface authorization needs comprehensive matrix testing. |
| Deployment/backup/ops | scripts/, packaging/, systemd/, docker/docker-compose.yml, db backup/admin family | Secret-file configuration and loopback services appear in templates. No deploy, restart, backup restore or live config inspection performed. Container version pinning requires follow-up. |
| Tests and CI | test/run-all.js -> suite-runner.js + manifests; .github/workflows/ci.yml and quality.yml | Required tiers exclude compatibility and e2e by default. CI has architecture/docs/security/domain jobs. Windows local environment differs from Linux CI. See validation record for actual execution. |

## Canonical descriptor snapshot

Extracted from getCanonicalRegistry({includeActiveModules:false}) in the isolated baseline. Every name also resolves through the sidekick_ compatibility prefix. Descriptions and schemas remain owned by code; table is an audit snapshot. No live/module/generated catalog completeness claim.

| Name | Family | Risk | Explicit aliases |
| --- | --- | --- | --- |
| analytics | media | medium |  |
| anonymize | security | low |  |
| archive | process-mgmt | medium |  |
| baseline | monitoring | high |  |
| bash | shell | critical |  |
| batch | flow-control | medium |  |
| black_box | black-box | medium |  |
| browser | browser | high |  |
| cache | storage | low |  |
| capability | capability-packs | critical | capability_pack, pack |
| changelog | development | medium |  |
| ci_status | github | low |  |
| circuit | flow-control | medium |  |
| compute | compute | medium |  |
| compute_jobs | compute | medium |  |
| compute_models | compute | medium |  |
| compute_nodes | compute | medium |  |
| compute_providers | compute | high |  |
| compute_route | compute | medium |  |
| connector | connectors | medium |  |
| context | context | medium |  |
| cron | scheduling | high |  |
| db_backup | database-admin | medium |  |
| db_diff | database-inspection | low |  |
| db_export | database-admin | medium |  |
| db_migrate | database-admin | high |  |
| db_query | database-inspection | medium |  |
| db_restore | database-admin | critical |  |
| db_schema | database-inspection | low |  |
| db_search | database-inspection | low |  |
| db_stats | database-inspection | low |  |
| debug_tool | meta | low |  |
| delay | scheduling | high |  |
| delete | storage | low |  |
| depend | development | medium |  |
| diff_files | filesystem | low |  |
| download | media | medium |  |
| embed | inference | low |  |
| evolve | evolve | critical |  |
| filter | filesystem | low |  |
| find | filesystem | medium |  |
| fresheyes | meta | medium |  |
| get | storage | low |  |
| get_by_project | storage | low |  |
| git | development | medium |  |
| github | github | high |  |
| handoff | memory-handoff | medium |  |
| hash | hashing | low |  |
| health | observability | high |  |
| insight_report | media | low |  |
| knowledge | knowledge | low |  |
| list | filesystem | low |  |
| list_projects | storage | low |  |
| llm | inference | medium |  |
| log_query | database-inspection | low |  |
| media | media | medium |  |
| memory | memory-core | medium |  |
| memory_export | memory-portability | low |  |
| memory_import | memory-portability | medium |  |
| memory_maintenance | memory-maintenance | critical |  |
| memory_manage | memory-lifecycle | medium |  |
| metrics | observability | low |  |
| mission | operations | critical |  |
| module | module-management | high | modules |
| netdiag | observability | high |  |
| network_scopes | network-scopes | critical | network_scope |
| nginx | networking | high |  |
| notify | comms | medium |  |
| ocr | media | medium |  |
| ollama | inference | low |  |
| ops | operations | critical |  |
| orchestrate | flow-control | high |  |
| predict | meta | medium |  |
| process | process-mgmt | high |  |
| project | context | low |  |
| project_registry | project-registry | high |  |
| queue | flow-control | high |  |
| read | filesystem | medium |  |
| redis | storage | medium |  |
| respond | utility | low |  |
| resume | resume | low |  |
| retry | flow-control | medium |  |
| runbook | runbook | critical |  |
| sandbox | security | critical |  |
| search | filesystem | low |  |
| secret | secret | high |  |
| security_scan | security | low |  |
| service | process-mgmt | high |  |
| session | memory-session | medium |  |
| snapshot | monitoring | medium |  |
| status | observability | medium |  |
| store | storage | low |  |
| summarize | filesystem | low |  |
| sync_diff | memory-sync | low |  |
| sync_export | memory-sync | low |  |
| sync_identity | memory-sync | low |  |
| sync_import | memory-sync | medium |  |
| tail | monitoring | medium |  |
| teach | teach | high |  |
| timeline | monitoring | medium |  |
| tools | tool-catalog | low |  |
| transcribe | media | medium |  |
| tunnel | networking | high |  |
| watch | scheduling | high |  |
| web_fetch | net-fetch | medium |  |
| webhook | comms | low |  |
| wireguard | networking | high |  |
| workflow | workflow-definitions | high | workflows |
| workspace | workspace | high |  |
| write | filesystem | critical |  |

## Direct dependency inventory

Node v24.18.0, npm 11.16.0, SQLite 3.53.4. Dependencies reused read-only; no install, upgrade or network audit.

| Dependency | Lockfile | Installed |
| --- | --- | --- |
| @modelcontextprotocol/server | 2.0.0 | 2.0.0 |
| @modelcontextprotocol/server-legacy | 2.0.0 | 2.0.0 |
| ajv | 8.20.0 | 8.20.0 |
| better-sqlite3 | 13.0.3 | 13.0.3 |
| cors | 2.8.6 | 2.8.6 |
| express | 5.2.1 | 5.2.1 |
| fast-xml-parser | 5.11.0 | 5.11.0 |
| handlebars | 4.7.10 | 4.7.10 |
| ignore | 7.0.6 | 7.0.6 |
| ini | 7.0.0 | 7.0.0 |
| ioredis | 6.0.0 | 6.0.0 |
| pg | 8.23.0 | 8.23.0 |
| playwright-core | 1.62.1 | 1.62.1 |
| tree-sitter | 0.25.1 | 0.25.1 |
| tree-sitter-go | 0.25.0 | 0.25.0 |
| tree-sitter-java | 0.23.5 | 0.23.5 |
| tree-sitter-javascript | 0.25.0 | 0.25.0 |
| tree-sitter-perl | 1.2.1 | 1.2.1 |
| tree-sitter-ruby | 0.23.1 | 0.23.1 |
| tree-sitter-rust | 0.24.0 | 0.24.0 |
| tree-sitter-typescript | 0.23.2 | 0.23.2 |
| yaml | 2.9.0 | 2.9.0 |
| zod | 4.4.3 | 4.4.3 |

The initial checkout was clean on main; improvement branch: improvement/platform-continuity-audit. Git required explicit work-tree selection in this tool environment. Tests use an exported tracked-source snapshot, no .env, a separate Git repository and disposable data.

