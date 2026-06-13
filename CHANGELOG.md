# Changelog

All notable changes to Sidekick.

## 2026-06-13

### v1.18: Operations Platform Expansion (10 new tools)
- **`sidekick_anonymize`** — Replace sensitive data with realistic fake values. Consistent mapping, custom patterns, safety net via redact.
- **`sidekick_sandbox`** — Execute operations with automatic file backup and rollback. Safe experimentation on remote systems.
- **`sidekick_changelog`** — Generate release notes from git history. Groups by type/scope/author, optional LLM summaries.
- **`sidekick_netdiag`** — Unified network diagnostics: DNS, routing, port scanning, connectivity checks, local listeners.
- **`sidekick_timeline`** — Build chronological timelines from multiple sources (log.jsonl, journalctl, git, files).
- **`sidekick_circuit`** — Generic circuit breaker for any tool call. Fast-fail when targets are down, configurable thresholds.
- **`sidekick_baseline`** — Behavioral baseline and anomaly detection. Learns patterns, detects statistical deviations.
- **`sidekick_depend`** — Dependency analyzer for npm, systemd services, processes. Trees, reverse deps, impact analysis.
- **`sidekick_runbook`** — Operational runbook executor with autonomous and guided modes. Verification, rollback, step-by-step.
- **`sidekick_black_box`** — Incident time capsule capturing full system context. Rate limited (5/day, 7-day TTL, 3 active max).
- Total tools: 49 → 59

## 2026-06-11

### v1.15: Meta-Capabilities (evolve, orchestrate, predict)
- **`sidekick_evolve`** — Self-modification with safety: analyze tool usage patterns, propose improvements, test and approve changes
  - Analyzes tool usage logs to find frequent patterns
  - Proposals require testing and explicit approval
  - Rate limited to 10 proposals per day
  - Tracks proposal history and feedback
- **`sidekick_orchestrate`** — Multi-agent coordination: create task graphs, execute subtasks with dependencies
  - Supports parallel and sequential execution
  - Dependency tracking between subtasks
  - Resource limits (timeout, concurrent tasks)
  - Progress tracking across all subtasks
- **`sidekick_predict`** — Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness
  - Analyzes context and tool usage patterns
  - Generates predictions with confidence scores
  - Tracks prediction usefulness via feedback
  - Suggests actions based on past predictions
- Total tools: 34 → 37

### v1.14: Workflow & Reliability (validate, template, queue, retry)
- **`sidekick_validate`** — Validate data against JSON Schema using ajv
  - Supports JSON Schema draft-07
  - Returns detailed error messages with paths
  - Auto-parses JSON strings
- **`sidekick_template`** — Render Handlebars templates with data
  - Supports variables, conditionals, loops, and helpers
  - For config generation and dynamic content
- **`sidekick_queue`** — Persistent task queue with priorities
  - Priority-based task scheduling
  - Status tracking (pending/processing/completed/failed)
  - Automatic retry tracking with attempt counts
- **`sidekick_retry`** — Retry wrapper for tool calls with backoff
  - Exponential, linear, and fixed backoff strategies
  - Configurable max attempts and initial delay
- Total tools: 30 → 34

### v1.13: Core Data Utilities (parse, diff, hash)
- **`sidekick_parse`** — Parse structured data formats with auto-detection
  - Supports JSON, YAML, XML, INI, CSV
  - Auto-detects format from content
  - Returns parsed JSON structure
- **`sidekick_diff`** — Semantic comparison with structure-aware diffing
  - Text diff (line-by-line)
  - JSON/YAML diff (structure-aware, shows added/removed/modified fields)
  - Output formats: unified, summary, JSON
- **`sidekick_hash`** — Checksum generation and verification
  - Algorithms: MD5, SHA1, SHA256, SHA512
  - Can hash strings or files
  - Verification mode to check against expected hash
- Added dependencies: yaml, fast-xml-parser, ini
- Total tools: 27 → 30

### v1.12: Companion Tools Phase 1 (transform, health)
- **`sidekick_transform`** — Data manipulation pipeline
  - Actions: filter, extract, sort, format, map
  - Format options: json, csv, table, text
  - Enables tool composition (bash | transform | context)
- **`sidekick_health`** — Composite system health checks
  - Checks: services, processes, disk, network, custom
  - Scoring system (0-100)
  - Threshold-based alerting
  - Stores health history for trending
- Total tools: 25 → 27

### v1.11: Companion Tools Phase 2 (delay, snapshot)
- **`sidekick_delay`** — One-shot task scheduling
  - Time formats: 10s, 5m, 2h, 1d, or ISO date
  - Agent bridge loads delays on startup
  - /api/delays/reload endpoint for live updates
- **`sidekick_snapshot`** — State capture and drift detection
  - Capture types: processes, services, disk, packages, network, files
  - Compare snapshots to detect added/removed/changed items
  - Stores snapshots in data/snapshots/
- Total tools: 23 → 25

### v1.10: Companion Tools Phase 3 (watch, secret)
- **`sidekick_watch`** — Event-driven monitoring
  - Sources: service, process, endpoint, file
  - Conditions: status!=active, not_running, status!=200, content_matches
  - Configurable intervals (30s, 5m, 1h)
  - Triggers tool calls when conditions met
  - Agent bridge loads watches on startup
- **`sidekick_secret`** — Encrypted credential management
  - AES-256-GCM encryption
  - Requires SIDEKICK_SECRET_KEY in .env
  - Actions: store, get, delete, list, rotate
  - Rotation with random value generation
- Total tools: 21 → 23

### Companion Tools Expansion (v1.10-v1.15)
- Implemented 10 new companion tools in 3 stages
- Stage 1 (Core Data Utilities): parse, diff, hash
- Stage 2 (Workflow & Reliability): validate, template, queue, retry
- Stage 3 (Meta-Capabilities): evolve, orchestrate, predict
- All tools follow Unix philosophy: single responsibility, composable
- Total tools: 21 → 37

### v1.5: sidekick_teach - Meta-Learning and Self-Extension
- **`sidekick_teach`** — Revolutionary tool that enables sidekick to learn new procedures and generate new tools dynamically
- Actions: teach_procedure, generate_tool, learn_from_example, execute, list, remove
- Uses LLM to generate procedure steps from natural language descriptions
- Stores procedures as JSON for safety and portability
- Transforms sidekick from a fixed tool server into a self-extending platform
- Total tools: 20 → 21

### v1.4: sidekick_context - Persistent Intelligent Context Management
- **`sidekick_context`** — Tracks projects, decisions, problems, and patterns across sessions
- Actions: track_project, track_decision, track_problem, track_pattern, recall, suggest, summarize, list
- Semantic similarity search for intelligent recall
- Proactive suggestions based on past context
- Stores context in `data/context.json`
- Total tools: 19 → 20

### v1.3: Automation and Integration Tools
- **`sidekick_cron`** — Schedule recurring tasks using system crontab
  - Actions: add, list, remove, run
  - Stores jobs in `data/cron.json`
  - Syncs with system crontab for execution
- **`sidekick_github`** — Full GitHub API integration
  - Actions: pr_list, pr_create, pr_get, pr_merge, issue_list, issue_create, issue_close, commit_status, release_create, repo_info
  - Uses stored `github_token` from KV
- **`sidekick_webhook`** — Receive and manage webhooks from external services
  - Actions: list, get, clear
  - Webhook endpoint: `POST /api/webhook/:source` on dashboard
  - Stores webhooks in `data/webhooks.json` (max 1000)
- Total tools: 16 → 19

### v1.2: VPS Management Tools
- **`sidekick_process`** — Manage processes (list, top CPU/memory, kill, tree)
  - Actions: list, top, kill, tree
  - Filter by name, kill by PID or name
- **`sidekick_service`** — Manage systemd services safely
  - Actions: start, stop, restart, status, enable, disable, logs
  - Validates service names, prevents dangerous commands
- **`sidekick_archive`** — Create, extract, or list archives
  - Actions: create, extract, list
  - Formats: tar.gz, tgz, zip
- Total tools: 13 → 16

### v1.1: Core Utility Tools
- **`sidekick_search`** — Fast file content search using ripgrep (falls back to grep)
  - Supports regex patterns and file filtering
  - Much faster than manual bash grep
- **`sidekick_git`** — Structured git operations
  - Actions: status, diff, log, add, commit, push, pull, branch, checkout, stash
  - Safer than raw bash for git commands
  - Validates actions, prevents dangerous operations
- **`sidekick_notify`** — Send notifications to Discord, Slack, or email
  - Discord/Slack via webhooks
  - Email via SMTP (requires SMTP_HOST, SMTP_USER, SMTP_PASS env vars)
- Total tools: 10 → 13

### SSH Key Infrastructure
- Generated new ED25519 SSH key on VPS
- Added to authorized_keys for both root and sidekick users
- Saved to `C:\Users\geoffrey\.ssh\sidekick` on Windows
- Replaced old broken key that wasn't working
- All deploys now use the new key successfully

## 2026-06-10

### Dashboard Security Hardening
- Added rate limiting (200 requests per 15 minutes per IP)
- Added request size limits (1MB max)
- Added CSRF protection via Origin header validation
- Added IP whitelist support (`SIDEKICK_DASHBOARD_ALLOWED_IPS`)
- Added audit logging for all state-changing operations (PUT/DELETE)
- Added error logging endpoint for frontend errors
- Added `credentials: 'same-origin'` to all 15 fetch() calls
- Replaced all 14 silent `.catch(()=>{})` with proper error handler (`apiError`)
- Added toast notification system for user-friendly error messages
- Added centralized error logging to `/data/dashboard-errors.log`
- Added tab-aware auto-refresh (only refresh when System tab visible)
- Added Page Visibility API check to reduce unnecessary API calls

### Dashboard Syntax Fix
- Fixed template literal escape sequences in frontend JavaScript (commits `d806a4f`, `3279cdd`)
- Lines 749, 768: Inner template literals needed escaping (`\`` and `\${}`)
- Lines 982, 1109, 1113, 1116, 1155: Single-quoted onclick handlers needed double backslash (`\\'` instead of `\'`)
- Root cause: Inside Node.js template literal, `\'` is unrecognized escape → Node strips backslash → bare `'` breaks browser JS

### Sensitive Data Redaction
- All tool outputs automatically scanned for sensitive data and redacted before logging or display
- Patterns: SSH keys (RSA, EC, DSA, OPENSSH), GitHub tokens (ghp_, github_pat_), API keys (sk-*), AWS keys (AKIA*, aws_secret_*), passwords in env vars, Bearer tokens, database connection strings, Stripe keys, JWT tokens

### Project Labeling System
- KV store supports project-based organization via `project` parameter
- Dashboard shows project badges and filtering
- Better context grouping across sessions

### Enhanced Dashboard UI
- Timestamps with relative time display ("Created 2h ago", "Updated 5m ago")
- Source badges showing where data came from (mcp/agent/dashboard)
- Expandable value previews — click to see full content in a modal
- Age filtering — filter by today/this week/this month/all time
- Failed command highlighting — red background and border for errors
- Sort by updated date — newest entries first

### Testing Strategy
- Comprehensive testing strategy developed: 7 priority levels, 19 hours estimated
- Priority 1: Security tests (redaction, auth, dangerous commands) — 4 hours
- Priority 2: Error handling — 3 hours
- Priority 3: MCP protocol compliance — 3 hours
- Priority 4: Agent bridge — 3 hours
- Priority 5: Dashboard APIs — 2 hours
- Priority 6: Performance — 2 hours
- Priority 7: Backward compatibility — 2 hours
- Tests written and ready for local validation

## 2026-06-09

### Initial VPS Deployment
- Migrated to new VPS (149.28.229.13)
- Set up SSH keys and authentication
- Deployed all services (MCP, Dashboard, Agent)
- Initial KV store seeding with 35 system reference keys (IP, services, security, software, deployment)
- Created `sidekick` user with restricted sudo (service management only)
- Configured fail2ban, UFW, unattended-upgrades

### Core Architecture
- MCP Server (`:4097`) — 10 tools, session-aware transport (new McpServer+Transport per session)
- Dashboard (`:4098`) — web UI with System, Activity, Data, Config, and Agent tabs
- Agent Bridge (`:4099`) — autonomous LLM agent that calls tools directly (bypasses MCP HTTP)
- Ollama (`:11434`) — local Phi-3-mini fallback, cloud Groq API when `GROQ_API_KEY` is set

### AGENTS.md Integration
- Leveraged opencode's AGENTS.md mechanism for persistent collaboration
- Sidekick reads instructions on every session start
- KV store provides cross-session memory
- `@sidekick` subagent for complex multi-step tasks
