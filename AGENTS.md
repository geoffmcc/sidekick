# Sidekick VPS

A remote VPS agent system. Connect via the sidekick MCP server at `YOUR_VPS_IP:4097`.

## Sidekick Interaction Policy

Always use the `task` tool with `subagent_type: "sidekick"` when interacting with sidekick. Do not use direct MCP tools (`sidekick_bash`, `sidekick_read`, etc.) — use the task tool so the user can see the full conversation. 100% of the time, no exceptions.

## MCP Tools (21)

| Tool | When to use |
|------|-------------|
| `sidekick_bash` | Run any shell command on the VPS |
| `sidekick_read` | Read a file from the VPS filesystem |
| `sidekick_write` | Write or edit a file on the VPS |
| `sidekick_list` | List files and directories on the VPS |
| `sidekick_search` | Search file contents using ripgrep/grep (faster than bash grep) |
| `sidekick_git` | Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash) |
| `sidekick_notify` | Send alerts to Discord, Slack, or email |
| `sidekick_process` | Manage processes (list, top CPU/memory, kill, tree) |
| `sidekick_service` | Manage systemd services (start, stop, restart, status, enable, disable, logs) |
| `sidekick_archive` | Create, extract, or list archives (tar.gz, zip) |
| `sidekick_cron` | Schedule recurring tasks (add, list, remove, run jobs) |
| `sidekick_github` | GitHub API integration (PRs, issues, commits, releases) |
| `sidekick_webhook` | Manage received webhooks (list, get, clear) |
| `sidekick_context` | Persistent intelligent context management (track projects, decisions, problems, patterns; recall and suggest based on past context) |
| `sidekick_teach` | Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows |
| `sidekick_store` | Store a value persistently in KV storage |
| `sidekick_get` | Retrieve a stored value from KV storage |
| `sidekick_list_projects` | List all projects in KV storage |
| `sidekick_get_by_project` | Get all keys and values for a specific project |
| `sidekick_web_fetch` | Fetch a URL from the VPS IP (bypasses local IP restrictions) |
| `sidekick_llm` | Query the LLM (Groq cloud or local Phi-3-mini) |

All tool calls are logged with source tags:
- 🤖 **agent** - Calls from the autonomous agent bridge
- 🔌 **mcp** - Calls from external MCP clients (opencode, etc.)
- ❓ **unknown** - Legacy calls without source tag

## Services

- **MCP Server** (`:4097`) — 21 tools, session-aware transport (new McpServer+Transport per session)
- **Dashboard** (`:4098`) — web UI with System, Activity, Data, Config, and Agent tabs, Font Awesome icons
- **Agent Bridge** (`:4099`) — autonomous LLM agent that calls tools directly (bypasses MCP HTTP)
- **Ollama** (`:11434`) — local Phi-3-mini fallback. Uses cloud Groq API when `GROQ_API_KEY` is set

## Recent Features

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
- **Dashboard**: Open `http://YOUR_VPS_IP:4098/` in a browser (auth: geoffrey) for system monitoring and the agent chat interface.

## Deployment

### Windows (PowerShell)
```powershell
.\deploy.ps1
```

### Linux/Mac (Bash)
```bash
./deploy.sh
```

### Manual (SSH)
```bash
ssh sidekick@YOUR_VPS_IP
cd /home/sidekick/mcp-sidekick
git pull
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

## Configuration

Edit `.env` locally, then deploy. The deploy script syncs `.env` to VPS automatically.

Key env vars:
- `SIDEKICK_API_KEY` - MCP server auth
- `SIDEKICK_DASHBOARD_USER/PASS` - Dashboard auth
- `GROQ_API_KEY` - Cloud LLM (optional, falls back to Ollama)
- `SIDEKICK_MAX_ITERATIONS` - Agent loop limit (default: 15)

## Security

- SSH key: `~/.ssh/sidekick` (dedicated key for this VPS)
- API keys in `.env` (gitignored)
- `opencode.json` has API key and IP (gitignored)
- Dashboard uses HTTP Basic Auth
- MCP server uses Bearer token + IP whitelist
- Agent bridge binds to 127.0.0.1 only

See `CONTEXT.md` for full project context, architecture details, and testing commands.
