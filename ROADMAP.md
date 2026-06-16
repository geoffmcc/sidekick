# Roadmap

What's planned for Sidekick.

## Current (v1.19)

- 83 built-in MCP tools. Query the `tools` table for the authoritative current list.
- Live dashboard with 6 tabs (System, Activity, Data, Config, Agent, Tools)
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
- Total tools: 59 → 70 at this milestone; current built-in total is 83.
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

### Proxmox Migration
- Migrate from VPS to local Proxmox VM
- 12GB VM with on-demand Ollama strategy
- AMD GPU passthrough (Radeon 680M)
- Native Ollama (not Docker) for simpler AMD GPU management
- Device passthrough for GPU with fallback plan
- Clean shutdown via Proxmox UI
- Systemd dependencies with health checks
- Proxmox snapshots with qemu-guest-agent

### CI/CD Integration
- ✅ **sidekick_github** — Full GitHub API integration (PRs, issues, commits, releases)
- Trigger GitHub Actions workflows from sidekick
- Report build/test status back to GitHub PRs
- Automated deployment pipelines with rollback capabilities
- Watch for PR events and run checks automatically

### Multi-User Support
- Team collaboration features (shared workspace, concurrent sessions)
- Role-based access control (admin, developer, viewer)
- Per-user KV namespaces
- Audit logging for team actions

### Security & Compliance
- Dedicated security scanning tools (nmap, lynis, dependency audits)
- Automated compliance checks
- Vulnerability reporting and tracking
- Integration with security advisory databases

### Notifications & Integrations
- ✅ **sidekick_notify** — Send notifications to Discord, Slack, or email
- ✅ **sidekick_webhook** — Receive and manage webhooks from external services
- ✅ **sidekick_watch** — Event-driven monitoring (watch services, processes, endpoints, files)
- RSS/Atom feed for activity log
- API for external integrations

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
- Long-running task persistence (survive VPS restarts)
- Agent-to-agent communication
- ✅ **sidekick_context** — Persistent intelligent context management
- ✅ **sidekick_teach** — Meta-learning and self-extension
- ✅ **sidekick_evolve** — Self-modification with safety (analyze patterns, propose improvements)
- ✅ **sidekick_predict** — Anticipatory intelligence (predict needs, track usefulness)

---

Have ideas? Open an issue on GitHub.
