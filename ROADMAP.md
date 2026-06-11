# Roadmap

What's planned for Sidekick.

## Current (v1.5)

- 21 MCP tools (bash, read, write, list, search, git, notify, process, service, archive, cron, github, webhook, context, teach, store, get, list_projects, get_by_project, web_fetch, llm)
- Live dashboard with 5 tabs (System, Activity, Data, Config, Agent)
- Autonomous agent bridge with Groq cloud + local Ollama fallback
- Persistent KV storage across sessions
- AGENTS.md integration for persistent collaboration
- Project labeling system for KV store (organize by project)
- Sensitive data redaction (SSH keys, tokens, passwords, etc.)
- Enhanced dashboard with timestamps, source badges, expandable content
- Comprehensive testing strategy (7 priority levels, 19 hours estimated)
- Dashboard security hardening (rate limiting, CSRF protection, audit logging, error handling)
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

## Recently Completed ✅

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

## Current Blockers 🟡

### MCP Connection Issues
**Status:** Unresolved (HIGH PRIORITY)  
**Impact:** Blocking reliable use of Sidekick from opencode  
**Timeline:** Week 1-3 for investigation/fix

**Symptoms:**
- "Server not initialized" errors
- Intermittent tool call failures
- Session management problems

**Success Criteria:**
- Zero errors over 24-hour period
- 100+ consecutive successful tool calls
- Clear error messages when failures occur

See `CONTEXT.md` for detailed investigation plan and root cause hypotheses.

## Planned

### Proxmox Migration (After MCP issues resolved - Week 4+)
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
- RSS/Atom feed for activity log
- API for external integrations

### Enhanced Agent Capabilities
- Multi-agent orchestration (specialized agents working together)
- ✅ **sidekick_cron** — Scheduled tasks and cron-like automation
- Long-running task persistence (survive VPS restarts)
- Agent-to-agent communication
- ✅ **sidekick_context** — Persistent intelligent context management
- ✅ **sidekick_teach** — Meta-learning and self-extension

---

Have ideas? Open an issue on GitHub.
