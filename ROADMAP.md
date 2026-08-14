# Roadmap

What's planned for Sidekick.

## Current

> Platform architecture status, tool-ownership counts, and the active
> convergence roadmap are tracked authoritatively in
> `docs/platform-convergence-audit.md` and `docs/platform-roadmap.md`. The
> feature list further below is a product history and is not the source of
> truth for tool counts.

**Where the platform stands (2026-08-14):**

- 106 built-in MCP tools in the core registry, plus tools contributed by
  installed modules (6 from the bundled `data-utilities` module; 3 more when
  the Developer capability pack is installed and enabled). Query the `tools`
  table for the authoritative live list.
- The modular tool runtime is complete: descriptor registry, centralized
  dispatcher, source-aware policy, approvals, redaction, and audit are the one
  production execution path, and `src/tools-legacy.js` owns zero tool handlers.
- **Capability Packs v1 shipped.** Sidekick Core no longer has to absorb every
  future area of functionality. A pack is an installable area of competence
  composed from modules, workflows, knowledge and configuration, managed
  through the `capability` tool and the dashboard **Capabilities** page. The
  first-party Developer / Software Engineering pack ships bundled. See
  `docs/capability-packs.md` and `docs/developer-pack.md`.
- **The module lifecycle is complete for third-party modules (B9).** Managed
  module store, safe package inspection, verified entry-point loading with
  whole-package integrity, install/configure/enable/disable/upgrade/uninstall,
  and a derived health model. Installed module code is trusted executable code
  with integrity and lifecycle controls — not a sandbox.
- **Workflow definitions are runnable.** `platform_workflow_definitions` plus a
  runner that drives the existing kernel workflow/execution primitives and the
  single tool dispatcher, with durable state, checkpoints, project identity,
  cancellation and approval continuation.
- Completed architecture: Agent Bridge with follow-ups and evidence honesty;
  Sidekick Compute (workers, providers, placement, jobs, artifacts, OpenVINO
  NPU embeddings); durable task-originated approval continuation; execution
  claims/leases for cron/delay/watch/runbook; Black Box incident evidence;
  structured memory with sessions, handoffs, and sync.
- Active convergence (`docs/platform-roadmap.md` Track B): event consumption
  (B5), artifact custody convergence (B6), connector integration (B7), and
  compute/model deduplication (B8) remain pending, separate campaigns.
- Foundation-only (implemented but not production-wired): event
  delivery/consumers, connector integrations, durable users/teams/deployment
  profiles, evaluation/replay, and the generic security-research records.

## Feature history

The list below records features as they were added (tool names use the older
`sidekick_` prefix; canonical names today are unprefixed):

- Live dashboard tabs (Mission Control, System, Activity, Data, Memory, Database, Config, Agent, Approvals, Tools, Compute, Metrics)
- Autonomous agent bridge with Groq cloud + local Ollama fallback
- Persistent KV storage across sessions
- AGENTS.md integration for persistent collaboration
- Project labeling system for KV store (organize by project)
- Sensitive data redaction (SSH keys, tokens, passwords, etc.)
- Enhanced dashboard with timestamps, source badges, expandable content
- Comprehensive testing strategy (7 priority levels, 19 hours estimated)
- Dashboard security hardening (rate limiting, CSRF protection, audit logging, error handling)
- Configurable tool policy with risk classifications and dashboard policy visibility
- **sidekick_search** — Fast file content search using ripgrep/grep
- **sidekick_git** — Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash)
- **sidekick_notify** — Send notifications to Discord, Slack, or email
- **sidekick_process** — Manage processes (list, top CPU/memory, kill, tree)
- **sidekick_service** — Manage systemd services safely
- **sidekick_archive** — Create, extract, or list archives (tar.gz, zip)
- **sidekick_cron** — Schedule recurring tasks via system crontab
- **sidekick_github** — Full GitHub API integration (PRs, issues, commits, releases)
- **sidekick_webhook** — Receive and manage webhooks from external services
- **sidekick_context** — Persistent intelligent context management (track projects, decisions, problems, patterns)
- **sidekick_memory_export** — Export structured memories
- **sidekick_memory_import** — Import structured memories
- **sidekick_memory_manage** — Confirm, delete, expire, restore, and list memory lifecycle state
- **sidekick_sync_identity** — Manage machine/user identity for memory sync
- **sidekick_sync_export** — Export memories for cross-machine sync
- **sidekick_sync_import** — Import synced memories with conflict strategies
- **sidekick_sync_diff** — List memories changed since a timestamp
- **sidekick_teach** — Meta-learning and self-extension (teach procedures, generate tools, learn from examples)
- **sidekick_watch** — Event-driven monitoring (watch services, processes, endpoints, files)
- **sidekick_secret** — Encrypted credential management with AES-256-GCM
- **sidekick_delay** — One-shot task scheduling
- **sidekick_snapshot** — State capture and drift detection
- **sidekick_transform** — Data manipulation pipeline (filter, extract, sort, format, map)
- **sidekick_health** — Composite system health checks with scoring
- **sidekick_parse** — Parse structured data formats (JSON, YAML, XML, INI, CSV)
- **sidekick_diff** — Semantic comparison with structure-aware diffing
- **sidekick_hash** — Checksum generation and verification
- **sidekick_validate** — JSON Schema validation
- **sidekick_template** — Handlebars template rendering
- **sidekick_queue** — Persistent task queue with priorities
- **sidekick_retry** — Retry wrapper with backoff strategies
- **sidekick_evolve** — Self-modification with safety
- **sidekick_orchestrate** — Multi-agent coordination
- **sidekick_predict** — Anticipatory intelligence
- **sidekick_debug_tool** — Structured debugging cache for debug sessions
- **sidekick_fresheyes** — Fresh perspective from Sidekick's LLM
- **sidekick_batch** — Execute multiple tool calls in one request
- **sidekick_cache** — Session-scoped caching with TTL
- **sidekick_summarize** — Summarize large files before returning
- **sidekick_filter** — Filter file contents or directory listings
- **sidekick_project** — Get complete project context in one call
- **sidekick_tail** — Tail recent log entries with filtering
- **sidekick_diff_files** — Compare two files directly
- **sidekick_find** — Advanced file finder by name, date, size, content
- **sidekick_status** — Unified system status in one call
- **sidekick_extract** — Parse and extract specific fields from structured data
- **sidekick_anonymize** — Replace sensitive data with realistic fake values
- **sidekick_sandbox** — Execute operations with automatic backup and rollback
- **sidekick_changelog** — Generate release notes from git history
- **sidekick_netdiag** — Unified network diagnostics
- **sidekick_timeline** — Build chronological timelines from multiple sources
- **sidekick_circuit** — Circuit breaker for any tool call
- **sidekick_baseline** — Behavioral baseline and anomaly detection
- **sidekick_depend** — Dependency analyzer for npm, services, processes
- **sidekick_runbook** — Operational runbook executor (autonomous and guided)
- **sidekick_black_box** — Incident time capsule (rate limited: 5/day, 7-day TTL)
- **sidekick_respond** — Direct response tool for the Agent Bridge
- **sidekick_db_schema** — Inspect database schema
- **sidekick_db_query** — Raw SQL with readonly safety limits
- **sidekick_db_stats** — Database size and table statistics
- **sidekick_db_backup** — Timestamped database backup
- **sidekick_db_restore** — Restore database from backup
- **sidekick_log_query** — Filter tool logs by time, tool, source, and status
- **sidekick_db_export** — Export tables to JSON, CSV, or SQL
- **sidekick_db_search** — Full-text search across database tables
- **sidekick_db_migrate** — Schema migrations
- **sidekick_db_diff** — Compare database snapshots

## Recently Completed ✅

### v1.24: Capability Packs v1 and the Developer Pack
**Status:** COMPLETED
**Date:** 2026-08-12

**What Was Added:**
- **B9 third-party module lifecycle (complete):** managed module store under
  `<SIDEKICK_DATA_DIR>/modules/<name>/<version>/`; safe package inspection that
  never executes package code; verified `entry_point` loading gated on
  whole-package integrity, entry hash, containment, compatibility and
  configuration; real install/configure/enable/disable/upgrade/uninstall; a
  derived health model; cross-process convergence when installed code changes.
- **Capability Packs v1:** `sidekick.pack.json` manifest, managed pack store,
  component ownership, full lifecycle, derived health, and bundled first-party
  packs — built on the module, workflow and tool subsystems that already
  existed rather than a second plugin runtime.
- **Workflow definition registry and runner:** `platform_workflow_definitions`
  plus a runner over the existing kernel workflow/execution primitives; every
  step is a governed tool call.
- **Developer / Software Engineering pack (bundled, first-party):**
  `dev_repo_profile`, `dev_change_summary`, `dev_verify`; seven runnable
  workflows (repository reconnaissance, issue investigation, implement change,
  CI triage, pull request review, dependency upgrade, release preparation);
  eight knowledge assets; twelve configuration options.
- **New tools:** `capability` (critical) and `workflow` (high).
- **Dashboard:** a first-class **Capabilities** page.
- Migration `036_capability_packs.sql`.

**Result:**
- Core registry tools: 103 -> 106 (+3 more when the Developer pack is enabled)
- B5, B6, B7 and B8 are complete; the remaining convergence work is the B7
  connector fast-follow and the explicitly scoped Track C items.


### v1.20: Structured Memory Completion
**Status:** COMPLETED
**Date:** 2026-06-17

**What Was Added:**
- Memory conflict detection and confidence-aware supersession
- Memory brief injection before Agent Bridge planning
- Memory import/export and review UI support
- Qdrant/Ollama semantic recall when optional services are available
- Memory lifecycle, confirmation, expiration, soft-delete, restore, and deferred state
- Cross-machine sync metadata and sync import/export/diff tools
- Migrations `004_memory_lifecycle.sql`, `005_sync_support.sql`, and `006_memory_deferred.sql`

**Result:**
- Total tools: 83 -> 90
- Structured memory is now queryable, reviewable, portable, and sync-aware

### v1.19: Database Tools and Tool Policy
**Status:** ✅ COMPLETED
**Date:** 2026-06-15

**What Was Added:**
- Database tools for schema inspection, readonly query, stats, backup/restore, log querying, export, search, migration, and diffing
- `sidekick_respond` for direct Agent Bridge responses
- Configurable tool policy with source-specific allow/block lists
- Risk classifications for every exported tool
- Dashboard policy visibility in the Tools tab

**Result:**
- Total tools: 59 -> 70 at this milestone; current built-in total is 90.
- High and critical risk tools can be gated without deleting operator capability

### v1.18: Operations Platform Expansion
**Status:** ✅ COMPLETED  
**Date:** 2026-06-13

**What Was Added:**
- `sidekick_anonymize` — Replace sensitive data with realistic fake values
- `sidekick_sandbox` — Execute operations with automatic backup and rollback
- `sidekick_changelog` — Generate release notes from git history
- `sidekick_netdiag` — Unified network diagnostics
- `sidekick_timeline` — Build chronological timelines from multiple sources
- `sidekick_circuit` — Circuit breaker for any tool call
- `sidekick_baseline` — Behavioral baseline and anomaly detection
- `sidekick_depend` — Dependency analyzer for npm, services, processes
- `sidekick_runbook` — Operational runbook executor (autonomous and guided)
- `sidekick_black_box` — Incident time capsule (rate limited)

**Result:**
- Total tools: 49 → 59
- All tools implemented, deployed, and tested

### MCP Connection Issues
**Status:** ✅ RESOLVED  
**Date:** 2026-06-11

**What Was Fixed:**
- Session management improvements in MCP server
- Proper initialization handling
- Connection stability enhancements

**Result:**
- Zero errors over extended period
- 100% reliable tool calls from opencode
- All 37 tools working consistently

### Dashboard Syntax Error Fix
**Status:** ✅ FIXED  
**Commits:** `d806a4f`, `3279cdd`  
**Date:** 2026-06-10

**What Was Fixed:**
- Template literal escape sequences in frontend JavaScript
- Lines 749, 768: Inner template literals needed escaping (`\`` and `\${}`)
- Lines 982, 1109, 1113, 1116, 1155: Single-quoted onclick handlers needed double backslash (`\\'` instead of `\'`)

**Root Cause:**
Inside a Node.js template literal (the entire HTML frontend), `\'` is an unrecognized escape sequence. Node strips the backslash, sending a bare `'` to the browser, which breaks JavaScript string concatenation and causes a syntax error that prevents all script execution.

**Verification:**
- `node -c src/dashboard.js` passes
- Dashboard service active and running
- All tabs functional (System, Activity, Data, Config, Agent)
- No JavaScript errors in browser console

### Dashboard RATE Graph Fix
**Status:** ✅ FIXED  
**Date:** 2026-06-11

**What Was Fixed:**
- Added `.warn` CSS class (amber `#d29922`) for 70-89% success rate range
- Fixed bar width floor from `Math.max(5, rate)` to `Math.max(1, rate)`
- Fixed color ternary to use `'warn'` instead of empty string for 70-89% range

**Root Cause:**
Tools with 70-89% success rate had no background color on the bar fill, making it appear as a full-width gray bar while the text showed a lower percentage.

## Planned

> Convergence work (the active engineering campaign) is tracked in
> `docs/platform-roadmap.md`, not here. This section lists product-level
> directions beyond that campaign.

### CI/CD Integration
- ✅ **github** — Full GitHub API integration (PRs, issues, commits, releases)
- ✅ **ci_status** — Read-only check-run/CI inspection for a PR head, SHA, ref, or branch
- Trigger GitHub Actions workflows from sidekick
- Automated deployment pipelines with rollback capabilities
- Watch for PR events and run checks automatically

### Multi-User Support
- Current state: single-operator authentication (one shared MCP API key, one
  dashboard account). An in-memory identity/teams/deployment-profile
  foundation exists (`src/platform/identity-deployment.js`) but is not
  persisted, enforced, or exposed anywhere.
- Remaining: durable users/teams/memberships tables, authentication
  integration, role-based access control, per-user KV namespaces, and team
  audit logging (tracked as optional slice C2 in `docs/platform-roadmap.md`).

### Security & Compliance
- ✅ **security_scan** — Read-only configuration and secret exposure scanning
- Dedicated network/system scanning integrations (nmap, lynis, dependency audits)
- Automated compliance checks
- Vulnerability reporting and tracking
- Integration with security advisory databases

### Notifications & Integrations
- ✅ **notify** — Send notifications to Discord, Slack, or email
- ✅ **webhook** — Receive and manage webhooks from external services
- ✅ **watch** — Event-driven monitoring (watch services, processes, endpoints, files)
- RSS/Atom feed for activity log
- API for external integrations
- First real connector through the generic connector framework (the framework
  stores lifecycle records today but governs no live integration)

### Completed infrastructure milestones

- **Proxmox migration** — completed 2026-06-12; Sidekick moved from a VPS to a
  local Proxmox VM. GPU passthrough and the WireGuard/Caddy remote-access layer
  from the original plan (`MIGRATION.md`, historical) were deferred.

### Data & Configuration Tools
- ✅ **sidekick_parse** — Parse structured data formats (JSON, YAML, XML, INI, CSV)
- ✅ **sidekick_diff** — Semantic comparison with structure-aware diffing
- ✅ **sidekick_hash** — Checksum generation and verification
- ✅ **sidekick_validate** — JSON Schema validation
- ✅ **sidekick_template** — Handlebars template rendering for config generation
- ✅ **sidekick_transform** — Data manipulation pipeline (filter, extract, sort, format, map)

### Reliability & Monitoring
- ✅ **sidekick_health** — Composite system health checks with scoring
- ✅ **sidekick_snapshot** — State capture and drift detection
- ✅ **sidekick_retry** — Retry wrapper with exponential/linear/fixed backoff
- ✅ **sidekick_secret** — Encrypted credential management with AES-256-GCM

### Enhanced Agent Capabilities
- ✅ **sidekick_orchestrate** — Multi-agent coordination (create task graphs, execute subtasks with dependencies)
- ✅ **sidekick_cron** — Scheduled tasks and cron-like automation
- ✅ **sidekick_delay** — One-shot task scheduling
- ✅ **sidekick_queue** — Persistent task queue with priorities
- ✅ Scheduled-work restart persistence — delays, watches, runbooks, and
  task-originated approvals recover across restarts via epoch-fenced execution
  claims; in-process `retry`/`orchestrate` runs remain non-durable
- Agent-to-agent communication
- ✅ **sidekick_context** — Persistent intelligent context management
- ✅ **sidekick_teach** — Meta-learning and self-extension
- ✅ **sidekick_evolve** — Self-modification with safety (analyze patterns, propose improvements)
- ✅ **sidekick_predict** — Anticipatory intelligence (predict needs, track usefulness)

---

Have ideas? Open an issue on GitHub.
