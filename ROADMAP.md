# Roadmap

What's planned for Sidekick.

## Current (v1.0)

- 8 MCP tools (bash, read, write, list, store, get, web_fetch, llm)
- Live dashboard with 5 tabs (System, Activity, Data, Config, Agent)
- Autonomous agent bridge with Groq cloud + local Ollama fallback
- Persistent KV storage across sessions
- AGENTS.md integration for persistent collaboration

## Planned

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
