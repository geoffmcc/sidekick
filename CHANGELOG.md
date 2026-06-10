# Changelog

All notable changes to Sidekick.

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
