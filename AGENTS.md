# Sidekick

A remote agent system. Connect via the sidekick MCP server at `YOUR_REMOTE_IP:4097`.

## Sidekick Interaction Policy

Always use the `task` tool with `subagent_type: "sidekick"` when interacting with sidekick. Do not use direct MCP tools (`sidekick_bash`, `sidekick_read`, etc.) — use the task tool so the user can see the full conversation. 100% of the time, no exceptions.

## Debugging Best Practices

When delegating debugging tasks to the sidekick task agent, include this instruction in the prompt:

```
"First, check for recent debug findings: sidekick_debug_tool action='recall' service='<service_name>'"
```

This surfaces past investigation findings before starting new work, avoiding redundant investigation.

**Example task prompt:**
```
Debug the dashboard service. First, check for recent debug findings: sidekick_debug_tool action='recall' service='dashboard'. Then investigate the issue, storing key findings with sidekick_debug_tool action='store' service='dashboard' issue='<description>'.
```

**When storing findings:**
- Use `service` parameter to identify the component (e.g., "dashboard", "mcp", "agent")
- Use `issue` parameter for a short description (e.g., "auth_blocking", "connection_timeout")
- Set `redact=false` only if you need to store sensitive data that shouldn't be redacted
- Findings persist for 7 days, then get flagged for cleanup

## Tool Creation Protocol

Before creating any new tool or tool suite:
1. Recall from KV store: `sidekick_get key="tool_making_guide" project="sidekick"`
2. If not available, read `docs/tool-creation.md` and store it in KV for next time

## Tools

**Tool information is stored in the database** and automatically synced on server startup.

To query available tools:
- Use `sidekick_db_query` with `database="sqlite"` to query the `tools` table
- Use `sidekick_db_query` with `database="postgres"` for PostgreSQL tools
- Tool categories are in the `tool_categories` table
- Tool-category mappings are in the `tool_category_map` table

Example query:
```sql
SELECT t.name, t.description, t.risk, tc.name as category
FROM tools t
LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
WHERE t.enabled = 1 AND t.deprecated = 0
ORDER BY tc.sort_order, t.name
```

**Knowledge Base**: Use `sidekick_knowledge` tool to search, get, list, add, update, or delete knowledge entries stored in the `knowledge` table.

### Core Tools (11)

| Tool | When to use |
|------|-------------|
| `bash` | Execute PowerShell commands on the local Windows machine |
| `edit` | String replacement in files (requires prior read) |
| `glob` | Find files by pattern (e.g. `**/*.ts`) |
| `grep` | Search file contents with regex, filter by file type |
| `read` | Read files and directories |
| `write` | Write files to the local filesystem |
| `question` | Ask the user questions during execution |
| `skill` | Load a specialized skill when task matches |
| `task` | Launch subagents (explore, general, sidekick) for complex tasks |
| `todowrite` | Track multi-step tasks with a todo list |
| `webfetch` | Fetch and convert URLs to markdown/text/html |

### Sidekick MCP Tools

Query the database for the full list of 92+ Sidekick tools, their descriptions, risk levels, and categories.

## Token Efficiency Rules

### Meta-Rules
1. NEVER use `sidekick_bash` when a specialized sidekick tool exists
2. When making 2+ independent sidekick calls, MUST use `sidekick_batch`
3. Before reading a file >100 lines, use `sidekick_summarize` first
4. Cache values needed 2+ times in a session with `sidekick_cache`

### Tool Selection Rules

| Task | MUST Use | NEVER Use |
|------|----------|-----------|
| Content search | `sidekick_search` | `sidekick_bash grep/rg` |
| Git operations | `sidekick_git` | `sidekick_bash git` |
| Service management | `sidekick_service` | `sidekick_bash systemctl` |
| Process management | `sidekick_process` | `sidekick_bash ps/kill/top` |
| Read large file (>100 lines) | `sidekick_summarize` | `sidekick_read` |
| Find files by criteria | `sidekick_find` | `sidekick_bash find/ls` |
| Filter directory listing | `sidekick_filter` | `sidekick_list` + manual filter |
| Compare two files | `sidekick_diff_files` | 2x `sidekick_read` |
| Tail/view logs | `sidekick_tail` | `sidekick_bash journalctl\|tail` |
| Extract config fields | `sidekick_extract` | `sidekick_read` + manual parse |
| Parse structured data | `sidekick_parse` | `sidekick_bash jq/python` |
| Project KV + context | `sidekick_project` | `sidekick_get_by_project` + `sidekick_context` |
| System health overview | `sidekick_status` | Multiple `sidekick_service` calls |
| Health assessment | `sidekick_health` | Manual service/process checks |
| Archive operations | `sidekick_archive` | `sidekick_bash tar/zip` |
| Semantic data diff | `sidekick_diff` | `sidekick_bash diff` |
| Checksums/hashing | `sidekick_hash` | `sidekick_bash md5sum/sha256sum` |
| Data transforms | `sidekick_transform` | `sidekick_bash awk/sed/jq` |
| Validate data | `sidekick_validate` | Manual validation |
| Render templates | `sidekick_template` | `sidekick_bash` with string concat |
| Network diagnostics | `sidekick_netdiag` | Multiple `sidekick_bash` ping/dig/ss calls |
| Build event timeline | `sidekick_timeline` | Multiple `sidekick_tail` + manual correlation |
| Capture incident context | `sidekick_black_box` | Multiple `sidekick_service`/`sidekick_process`/`sidekick_tail` calls |
| Wrap tool with circuit breaker | `sidekick_circuit` | Raw tool calls without failure protection |
| Debugging issues | `sidekick_debug_tool` | Repeated file reads, manual context tracking |

### Examples

**BAD:** `sidekick_bash "systemctl status sidekick-mcp"`
**GOOD:** `sidekick_service action="status" service="sidekick-mcp"`

**BAD:** `sidekick_service(mcp)` + `sidekick_service(dashboard)` + `sidekick_service(agent)` (3 calls)
**GOOD:** `sidekick_batch [service(mcp), service(dashboard), service(agent)]` (1 call)

**BAD:** `sidekick_read /path/to/500-line-file` (loads all 500 lines)
**GOOD:** `sidekick_summarize path=/path/to/500-line-file strategy=head max_lines=30`

**BAD:** `sidekick_read package.json` → manually find "version" field
**GOOD:** `sidekick_extract path=package.json fields="name,version"`

**BAD:** `sidekick_read fileA` + `sidekick_read fileB` + manual diff
**GOOD:** `sidekick_diff_files path_a=fileA path_b=fileB format=summary`

### Restricted Tools

Only use these when explicitly asked:
- `sidekick_fresheyes` — when asked for a fresh perspective
- `sidekick_notify` — only when asked or triggered by watch/cron

**Semi-proactive (surface opportunity, then ask):**
- `sidekick_evolve` — may analyze patterns and surface improvement opportunities, but MUST ask before proposing changes

### Tool Policy

Sidekick supports config-driven tool gating:
- `SIDEKICK_TOOL_POLICY=open` allows tools unless blocked.
- `SIDEKICK_TOOL_POLICY=restricted` blocks high and critical risk tools unless explicitly allowed.
- Source-specific overrides exist for `SIDEKICK_MCP_TOOL_POLICY`, `SIDEKICK_AGENT_TOOL_POLICY`, and `SIDEKICK_DASHBOARD_TOOL_POLICY`.
- Allow/block lists accept tool names and risk selectors such as `risk:high` or `risk:critical`.

High and critical tools should be treated as privileged operational capability, especially `sidekick_bash`, `sidekick_write`, `sidekick_db_restore`, `sidekick_runbook`, `sidekick_sandbox`, `sidekick_evolve`, `sidekick_process`, `sidekick_service`, `sidekick_cron`, `sidekick_delay`, `sidekick_watch`, `sidekick_github`, `sidekick_teach`, `sidekick_secret`, `sidekick_db_migrate`, `sidekick_queue`, and `sidekick_orchestrate`.

All tool calls are logged with source tags:
- 🤖 **agent** - Calls from the autonomous agent bridge
- 🔌 **mcp** - Calls from external MCP clients (opencode, etc.)
- ❓ **unknown** - Legacy calls without source tag

## Services

- **MCP Server** (`:4097`) — 70 tools, session-aware transport (new McpServer+Transport per session) at YOUR_REMOTE_IP
- **Dashboard** (`:4098`) — web UI with System, Activity, Data, Config, Agent, and Tools tabs, Font Awesome icons
- **Agent Bridge** (`:4099`) — autonomous LLM agent that calls tools directly (bypasses MCP HTTP)
- **Ollama** (`:11434`) — local Phi-3-mini fallback. Uses cloud Groq API when `GROQ_API_KEY` is set

## Recent Features

### DB-First Architecture (v1.20)
- **Tool Registry** — All tool metadata (name, description, risk, category) stored in database and synced on startup
- **Knowledge Base** — Structured knowledge entries in `knowledge` table, accessible via `sidekick_knowledge` tool
- **Auto-Migration** — Database migrations run automatically on server startup
- **Dashboard Integration** — Tool categories and knowledge entries accessible via dashboard API

### Monitoring & Metrics (v1.20)
- **Grafana Dashboards** — 6 pre-built dashboards: Overview, Tool Analytics, System Health, Database Performance, Docker Containers, Ollama
- **InfluxDB Integration** — Time-series metrics storage via `sidekick_metrics` tool
- **Auto-Provisioning** — Grafana datasources, dashboards, and alerting configured automatically

### Server Tooling (v1.19)
- **Infrastructure Tools** — Redis, OCR, Media, Transcribe, Analytics, Embed, Ollama, Tunnel, Download, WireGuard, Nginx
- **Database Support** — PostgreSQL support alongside SQLite for all `sidekick_db_*` tools
- **Setup Script** — Full tool stack installable via `scripts/setup-tools.sh`

### Project Labeling
KV store supports project-based organization. Use `project` parameter when storing data to group related keys. Dashboard shows project badges and filtering.

### Sensitive Data Redaction
All tool outputs automatically redact:
- SSH private keys (RSA, EC, DSA, OPENSSH)
- GitHub tokens (ghp_, github_pat_)
- API keys (sk-*, api_key=*)
- AWS keys (AKIA*, aws_secret_*)
- Passwords in env vars
- Bearer tokens
- Database connection strings
- Stripe keys
- JWT tokens

### Enhanced Dashboard
- Timestamps with relative time
- Source badges (mcp/agent/dashboard)
- Expandable value previews
- Age filtering (today/week/month/all)
- Failed command highlighting
- Sort by updated date

## Usage

- **Direct tool use**: Just use any `sidekick_*` tool — the MCP server handles it automatically.
- **Subagent (`@sidekick`)**: Use for complex multi-step tasks. The agent will plan, call tools, and iterate until the goal is met.
- **Dashboard**: Open `http://YOUR_REMOTE_IP:4098/` in a browser (auth: geoffrey) for system monitoring and the agent chat interface.

## Deployment

### Windows (PowerShell)
```powershell
.\deploy.ps1 -IP "YOUR_REMOTE_IP"
```

### Linux/Mac (Bash)
```bash
./deploy.sh -IP YOUR_REMOTE_IP
```

### First Deploy
On first deploy to a fresh VM, the script will:
- Prompt for the initial SSH user (e.g., ubuntu, admin, root)
- Open an SSH ControlMaster connection (prompts for password once)
- Bootstrap the VM by running `scripts/bootstrap.sh` remotely:
  - Create the sidekick user
  - Install Node.js 20 LTS
  - Configure sudoers for passwordless service management
  - Install and enable systemd services
  - Install your SSH key for passwordless access
  - Open firewall ports (if UFW is active)
- Sync files and start services

All privileged operations are performed during the bootstrap phase using the initial user's password. The SSH ControlMaster connection multiplexes all file transfers and commands through a single authenticated session, requiring only one password prompt.

### Subsequent Deploys
After first deploy, the script detects that services are already installed and skips all setup steps. Only minimal sudo permissions are used:
- `systemctl restart/stop/start/status sidekick-*`
- `journalctl -u sidekick-*`

No password is required for subsequent deploys.

### Automation/CI
```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -InitialUser "ubuntu"

# Linux/Mac
./deploy.sh -IP YOUR_REMOTE_IP -InitialUser ubuntu
```

### Manual (SSH)
```bash
ssh sidekick@YOUR_REMOTE_IP
cd /home/sidekick/sidekick
git pull
sudo systemctl restart sidekick-agent sidekick-dashboard sidekick-mcp
```

## Configuration

Edit `.env` locally, then deploy. The deploy script syncs `.env` to remote machine automatically.

Key env vars:
- `SIDEKICK_API_KEY` - MCP server auth
- `SIDEKICK_DASHBOARD_USER/PASS` - Dashboard auth
- `GROQ_API_KEY` - Cloud LLM (optional, falls back to Ollama)
- `SIDEKICK_MAX_ITERATIONS` - Agent loop limit (default: 15)

## Security

- SSH key: `~/.ssh/sidekick` (dedicated key for this remote machine)
- API keys in `.env` (gitignored)
- `opencode.json` has API key and IP (gitignored)
- Dashboard uses HTTP Basic Auth
- MCP server uses Bearer token + IP whitelist
- Agent bridge binds to 127.0.0.1 only

## Remote Service Management

The `sidekick` user has restricted sudo permissions for service management:

### Allowed Commands
```bash
sudo systemctl restart|stop|start|status sidekick-mcp
sudo systemctl restart|stop|start|status sidekick-dashboard
sudo systemctl restart|stop|start|status sidekick-agent
sudo journalctl -u sidekick-mcp
sudo journalctl -u sidekick-dashboard
sudo journalctl -u sidekick-agent
```

### Examples
```bash
# Restart MCP server
sudo systemctl restart sidekick-mcp

# Check service status
sudo systemctl status sidekick-mcp

# View recent logs
sudo journalctl -u sidekick-mcp -n 50
```

See `CONTEXT.md` for full project context, architecture details, and testing commands.

## Context Recall Protocol

When the user says any of these trigger phrases, automatically query sidekick's stored context and KV store without being asked:
- "remember that thing" / "recall" / "what did we save"
- "mcp setup" / "lan setup" / "tomorrow's plan"
- "the store" / "the context" / "stored"
- Any reference to something that was "saved" or "stored" previously

Procedure:
1. `sidekick_context action="recall" query="<topic>"` to search context patterns
2. `sidekick_get key="<topic>"` or `sidekick_get_by_project project="<project>"` for KV entries
3. Present the findings before taking any actions

## Troubleshooting

### MCP Server Logs
```bash
ssh sidekick@YOUR_REMOTE_IP
sudo journalctl -u sidekick-mcp -f
```

### Restart All Services
```bash
ssh sidekick@YOUR_REMOTE_IP
sudo systemctl restart sidekick-agent sidekick-dashboard sidekick-mcp
```

**Restart order matters:** agent first, dashboard second, MCP last. Restarting MCP first causes the other services to lock up waiting for it.

### Check All Services
```bash
ssh sidekick@YOUR_REMOTE_IP
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
```

### Dashboard (HTTP Basic Auth)
- URL: `http://YOUR_REMOTE_IP:4098/`
- Credentials in `.env` on remote machine: `SIDEKICK_DASHBOARD_USER` / `SIDEKICK_DASHBOARD_PASS`
