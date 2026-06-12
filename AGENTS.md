# Sidekick

A remote agent system. Connect via the sidekick MCP server at `YOUR_REMOTE_IP:4097`.

## Sidekick Interaction Policy

Always use the `task` tool with `subagent_type: "sidekick"` when interacting with sidekick. Do not use direct MCP tools (`sidekick_bash`, `sidekick_read`, etc.) — use the task tool so the user can see the full conversation. 100% of the time, no exceptions.

## Tools (48 total)

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

### Sidekick MCP Tools (37)

| Tool | When to use |
|------|-------------|
| `sidekick_bash` | Run any shell command on the remote machine |
| `sidekick_read` | Read a file from the remote filesystem |
| `sidekick_write` | Write or edit a file on the remote machine |
| `sidekick_list` | List files and directories on the remote machine |
| `sidekick_search` | Search file contents using ripgrep/grep (faster than bash grep) |
| `sidekick_git` | Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash) |
| `sidekick_notify` | Send alerts to Discord, Slack, or email |
| `sidekick_process` | Manage processes (list, top CPU/memory, kill, tree) |
| `sidekick_service` | Manage systemd services (start, stop, restart, status, enable, disable, logs) |
| `sidekick_archive` | Create, extract, or list archives (tar.gz, zip) |
| `sidekick_cron` | Schedule recurring tasks (add, list, remove, run jobs) |
| `sidekick_github` | GitHub API integration (PRs, issues, commits, releases) |
| `sidekick_webhook` | Manage received webhooks (list, get, clear) |
| `sidekick_context` | Persistent intelligent context management (track projects, decisions, problems, patterns, sessions; recall and suggest based on past context) |
| `sidekick_teach` | Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows |
| `sidekick_store` | Store a value persistently in KV storage |
| `sidekick_get` | Retrieve a stored value from KV storage |
| `sidekick_list_projects` | List all projects in KV storage |
| `sidekick_get_by_project` | Get all keys and values for a specific project |
| `sidekick_web_fetch` | Fetch a URL from the remote IP (bypasses local IP restrictions) |
| `sidekick_llm` | Query the LLM (Groq cloud or local Phi-3-mini) |
| `sidekick_transform` | Data manipulation pipeline: filter, extract, sort, format, map data |
| `sidekick_health` | Composite system health checks with scoring and issue detection |
| `sidekick_delay` | One-shot task scheduling (run a tool once at a specific time) |
| `sidekick_snapshot` | Capture system state and detect drift by comparing snapshots |
| `sidekick_watch` | Event-driven monitoring: watch services, processes, endpoints, files and trigger actions |
| `sidekick_secret` | Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY) |
| `sidekick_parse` | Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection |
| `sidekick_diff` | Semantic comparison of text, JSON, or YAML with structure-aware diffing |
| `sidekick_hash` | Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification |
| `sidekick_validate` | Validate data against JSON Schema |
| `sidekick_template` | Render Handlebars templates with data for config generation |
| `sidekick_queue` | Persistent task queue with priorities and status tracking |
| `sidekick_retry` | Retry tool calls with exponential/linear/fixed backoff |
| `sidekick_evolve` | Self-modification with safety: analyze patterns, propose improvements, test and approve changes |
| `sidekick_orchestrate` | Multi-agent coordination: create task graphs, execute subtasks with dependencies |
| `sidekick_predict` | Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness |

All tool calls are logged with source tags:
- 🤖 **agent** - Calls from the autonomous agent bridge
- 🔌 **mcp** - Calls from external MCP clients (opencode, etc.)
- ❓ **unknown** - Legacy calls without source tag

## Services

- **MCP Server** (`:4097`) — 37 tools, session-aware transport (new McpServer+Transport per session)
- **Dashboard** (`:4098`) — web UI with System, Activity, Data, Config, and Agent tabs, Font Awesome icons
- **Agent Bridge** (`:4099`) — autonomous LLM agent that calls tools directly (bypasses MCP HTTP)
- **Ollama** (`:11434`) — local Phi-3-mini fallback. Uses cloud Groq API when `GROQ_API_KEY` is set

## Recent Features

### New Tools (v1.15) - Meta-Capabilities
- **`sidekick_evolve`** — Self-modification with safety: analyze tool usage patterns, propose improvements, test and approve changes. Rate limited to 10 proposals per day.
- **`sidekick_orchestrate`** — Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress across all subtasks.
- **`sidekick_predict`** — Anticipatory intelligence: analyze context and tool patterns, predict needs, track prediction usefulness via feedback.

### New Tools (v1.14) - Workflow & Reliability
- **`sidekick_validate`** — Validate data against JSON Schema using ajv. Returns detailed error messages with paths.
- **`sidekick_template`** — Render Handlebars templates with data for config generation and dynamic content.
- **`sidekick_queue`** — Persistent task queue with priorities, status tracking, and automatic retry tracking.
- **`sidekick_retry`** — Retry wrapper for any tool call with exponential/linear/fixed backoff strategies.

### New Tools (v1.13) - Core Data Utilities
- **`sidekick_parse`** — Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection.
- **`sidekick_diff`** — Semantic comparison of text, JSON, or YAML with structure-aware diffing.
- **`sidekick_hash`** — Generate checksums (MD5, SHA1, SHA256, SHA512) for files or data with verification.

### New Tools (v1.12) - Companion Tools Phase 1
- **`sidekick_transform`** — Data manipulation pipeline: filter, extract, sort, format, and map data.
- **`sidekick_health`** — Composite system health checks with scoring and issue detection.

### New Tools (v1.11) - Companion Tools Phase 2
- **`sidekick_delay`** — One-shot task scheduling: run a tool once at a specific time or after a delay.
- **`sidekick_snapshot`** — Capture system state and detect drift by comparing snapshots.

### New Tools (v1.10) - Companion Tools Phase 3
- **`sidekick_watch`** — Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions.
- **`sidekick_secret`** — Encrypted credential management with AES-256-GCM (requires SIDEKICK_SECRET_KEY in .env).

### New Tools (v1.5)
- **`sidekick_teach`** — Meta-learning and self-extension: teach procedures, generate tools from descriptions, learn from examples, execute learned workflows. Enables sidekick to grow its own capabilities.

### New Tools (v1.4)
- **`sidekick_context`** — Persistent intelligent context management: track projects, decisions, problems, patterns; recall and suggest based on past context. Uses semantic similarity search.

### New Tools (v1.3)
- **`sidekick_cron`** — Schedule recurring tasks: add, list, remove, run jobs. Uses system crontab for scheduling.
- **`sidekick_github`** — Full GitHub API integration: PRs (list/create/get/merge), issues (list/create/close), commit status, releases, repo info. Uses stored `github_token`.
- **`sidekick_webhook`** — Receive and manage webhooks: list, get, clear. Webhook endpoint at `POST /api/webhook/:source` on dashboard.

### New Tools (v1.2)
- **`sidekick_process`** — Manage processes: list, top CPU/memory consumers, kill by PID/name, process tree.
- **`sidekick_service`** — Manage systemd services: start, stop, restart, status, enable, disable, view logs.
- **`sidekick_archive`** — Create, extract, or list archives (tar.gz, tgz, zip).

### New Tools (v1.1)
- **`sidekick_search`** — Fast file content search using ripgrep (falls back to grep). Supports regex patterns and file filtering.
- **`sidekick_git`** — Structured git operations: status, diff, log, add, commit, push, pull, branch, checkout, stash. Safer than raw bash for git commands.
- **`sidekick_notify`** — Send notifications to Discord, Slack (via webhooks), or email (via SMTP). Useful for alerts and monitoring.

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
- Detect the initial user (ubuntu, admin, or root)
- Prompt for the initial user's password (once)
- Bootstrap the VM by running `scripts/bootstrap.sh` remotely:
  - Create the sidekick user
  - Install Node.js 20 LTS
  - Set up SSH directory and keys
  - Configure sudoers for passwordless service management
  - Create application directories
  - Open firewall ports (if UFW is active)
- Copy SSH public key to the sidekick user
- Install and enable systemd services
- Sync files and start services

All privileged operations are performed during the bootstrap phase using the initial user's password.

### Subsequent Deploys
After first deploy, the script detects that services are already installed and skips all setup steps. Only minimal sudo permissions are used:
- `systemctl restart/stop/start/status sidekick-*`
- `journalctl -u sidekick-*`

No password is required for subsequent deploys.

### Automation/CI
```powershell
# Windows - with parameter
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -Password "initial_user_password"

# Windows - with environment variable
$env:SIDEKICK_INITIAL_PASSWORD="initial_user_password"
.\deploy.ps1 -IP "YOUR_REMOTE_IP"

# Linux/Mac - with parameter
./deploy.sh -IP YOUR_REMOTE_IP -Password "initial_user_password"

# Linux/Mac - with environment variable
SIDEKICK_INITIAL_PASSWORD="initial_user_password" ./deploy.sh -IP YOUR_REMOTE_IP
```

### Manual (SSH)
```bash
ssh sidekick@YOUR_REMOTE_IP
cd /home/sidekick/sidekick
git pull
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
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
ssh sidekick@149.28.229.13
sudo journalctl -u sidekick-mcp -f
```

### Restart MCP Service
```bash
ssh sidekick@149.28.229.13
sudo systemctl restart sidekick-mcp
```

### Check All Services
```bash
ssh sidekick@149.28.229.13
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
```

### Dashboard (HTTP Basic Auth)
- URL: `http://149.28.229.13:4098/`
- Credentials in `.env` on remote machine: `SIDEKICK_DASHBOARD_USER` / `SIDEKICK_DASHBOARD_PASS`
