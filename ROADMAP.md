# Roadmap

What's planned for Sidekick.

## Current (v1.0)

- 10 MCP tools (bash, read, write, list, store, get, list_projects, get_by_project, web_fetch, llm)
- Live dashboard with 5 tabs (System, Activity, Data, Config, Agent)
- Autonomous agent bridge with Groq cloud + local Ollama fallback
- Persistent KV storage across sessions
- AGENTS.md integration for persistent collaboration
- Project labeling system for KV store (organize by project)
- Sensitive data redaction (SSH keys, tokens, passwords, etc.)
- Enhanced dashboard with timestamps, source badges, expandable content
- Comprehensive testing strategy (7 priority levels, 19 hours estimated)

## Current Blockers 🔴

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
- Webhook support for Slack, Discord, Teams
- Email notifications for critical agent events
- RSS/Atom feed for activity log
- API for external integrations

### Enhanced Agent Capabilities
- Multi-agent orchestration (specialized agents working together)
- Scheduled tasks and cron-like automation
- Long-running task persistence (survive VPS restarts)
- Agent-to-agent communication

---

Have ideas? Open an issue on GitHub.
