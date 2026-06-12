# Sidekick

**Autonomous Agent Platform**

A self-hosted AI agent platform with persistent memory, 49+ tools, and the ability to extend itself. Runs on your remote machine, learns from your workflow, and grows its own capabilities—no code changes required.

**How?** A single `AGENTS.md` file that opencode reads on every session start. No plugins, no hooks — just markdown.

> **Note:** This project was developed using its own remote execution tools — the AI assistant used Sidekick's infrastructure to help build and test the very system it runs on.

<!-- TODO: Add dashboard screenshot -->
<!-- TODO: Add agent loop GIF -->

## Quick Start

**What you need:** Node.js 18+, a remote Ubuntu/Debian machine with SSH access (VPS, home server, Raspberry Pi), Git, ~15 minutes.

```powershell
# Clone the repo
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick

# Copy env template and edit
copy .env.example .env
# Edit .env with your API key and settings

# Deploy to your remote machine (Windows)
.\deploy.ps1 -IP "YOUR_REMOTE_IP"

# Or deploy (Linux/Mac)
./deploy.sh -IP YOUR_REMOTE_IP
```

**First deploy to a fresh VM:** The script will automatically:
- Prompt for the initial SSH user (e.g., ubuntu, admin, root)
- Prompt for the initial user's password (once)
- Create the sidekick user and install Node.js 20 LTS
- Configure sudo permissions for service management
- Install and enable systemd services
- Install your SSH key for passwordless access
- Open firewall ports (if UFW is active)
- Deploy the application and start services

**Subsequent deploys** are fully automated — no password required.

**For automation/CI**, specify the initial user with `-InitialUser`:
```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -InitialUser "ubuntu"

# Linux/Mac
./deploy.sh -IP YOUR_REMOTE_IP -InitialUser ubuntu
```

Open `http://YOUR_REMOTE_IP:4098/` in a browser. That's it — Sidekick is live.

## How It Works

Every time you open opencode, it automatically reads `~/.config/opencode/AGENTS.md` and loads whatever instructions are in it into the AI's context. Sidekick provides the infrastructure — remote execution tools, persistent memory, and an autonomous agent — that the AI can use.

1. **You open opencode** — it reads `AGENTS.md`
2. **Sidekick's tools and instructions are loaded** — the AI now knows about the remote machine, the tools, and how to use them
3. **You work** — the AI can call sidekick tools to execute commands on the remote machine, store/retrieve persistent data, or you can submit tasks to the autonomous Agent Bridge via the dashboard
4. **Session ends** — but anything stored in Sidekick's KV persists for next time

Sidekick is the infrastructure. The AI (running in opencode) uses that infrastructure to help you work. Without `AGENTS.md`, the AI doesn't know Sidekick exists. With it, the AI has persistent remote capabilities.

## What Makes Sidekick Different?

Most MCP servers are just tool wrappers—they give AI access to specific APIs or services. Sidekick is fundamentally different:

### 🧠 Persistent Memory Across Sessions
Sidekick remembers everything. Your decisions, project context, API responses, workflow patterns—it all persists in a structured KV store organized by project. The AI doesn't start from scratch every session.

### 🔄 Self-Extending Capabilities
Teach Sidekick new procedures, and it can generate its own tools. The `sidekick_teach` tool lets you describe a workflow in natural language, and Sidekick creates the implementation. It's not just using tools—it's building them.

### 🤖 True Autonomous Operation
The Agent Bridge runs independently from your main AI session. Submit a complex task via the dashboard, and Sidekick will plan, execute, and iterate until it's done—without you babysitting each step.

### 📊 Built-in Intelligence
- **Context tracking** - Automatically recalls relevant past decisions and patterns
- **Health monitoring** - Real-time system health checks with scoring
- **Predictive analysis** - Identifies patterns in your workflow and suggests improvements
- **Event-driven automation** - Watches for conditions and triggers actions automatically

### 🔒 Security-First Design
Every tool output is automatically scanned and redacted for sensitive data (API keys, tokens, passwords). The dashboard has rate limiting, CSRF protection, and audit logging. The agent bridge is isolated and only accessible through the dashboard.

### 🛠️ 49+ Specialized Tools
Not just bash and file operations. Sidekick includes tools for:
- GitHub integration (PRs, issues, releases)
- Service and process management
- Scheduled tasks and monitoring
- Data transformation and validation
- Multi-agent orchestration
- Encrypted credential management
- And much more

**The result:** Sidekick isn't just a tool server—it's an autonomous platform that learns, adapts, and grows with your workflow.

## What You Can Achieve

| Capability | How | Why AGENTS.md Matters |
|---|---|---|
| **Remote code execution** | `sidekick_bash` runs commands on a persistent remote machine | Instructions tell the AI when and how to use it |
| **Persistent memory across sessions** | `sidekick_store` / `sidekick_get` — KV storage that survives restarts | AI knows which keys to store and retrieve |
| **Autonomous multi-step tasks** | Agent bridge at `:4099` plans and executes until done | AI knows to delegate complex work to the agent |
| **Code review** | Ask the AI to review diffs using remote execution tools | Decision tree in AGENTS.md tells the AI *when* to use sidekick tools for review |
| **GitHub integration** | Stored tokens let sidekick create repos, push code, manage PRs | AGENTS.md tells the AI where to find credentials |
| **Live monitoring dashboard** | Web UI at `:4098` — system health, activity, KV data, agent tasks | Always accessible, no config needed |
| **Web scraping from remote** | `sidekick_web_fetch` bypasses local network restrictions | AI knows to use remote machine for fetching when needed |
| **LLM on demand** | Cloud Groq for speed, local Ollama as fallback | AI knows which to use and when |
| **File content search** | `sidekick_search` uses ripgrep/grep for fast code search | AI can quickly find code patterns across the codebase |
| **Git operations** | `sidekick_git` provides structured git commands | AI can check status, diff, log, commit, push, pull safely |
| **Notifications** | `sidekick_notify` sends alerts to Discord, Slack, or email | AI can alert you when tasks complete or errors occur |
| **Process management** | `sidekick_process` lists, monitors, and kills processes | AI can troubleshoot high CPU/memory or kill hung processes |
| **Service management** | `sidekick_service` controls systemd services safely | AI can restart services, check status, view logs |
| **Archive operations** | `sidekick_archive` creates/extracts tar.gz and zip files | AI can backup data, deploy archives, manage backups |
| **Scheduled tasks** | `sidekick_cron` schedules recurring jobs via crontab | AI can set up automated health checks, backups, monitoring |
| **GitHub automation** | `sidekick_github` manages PRs, issues, releases via API | AI can automate PR workflows, track issues, create releases |
| **Webhook integration** | `sidekick_webhook` receives and stores external webhooks | AI can react to GitHub events, CI/CD pipelines, external alerts |
| **Persistent context** | `sidekick_context` tracks projects, decisions, problems, patterns | AI can recall past context, get suggestions, maintain continuity across sessions |
| **Self-extension** | `sidekick_teach` teaches procedures, generates tools, learns from examples | AI can grow its own capabilities without code changes |

## Architecture

```
┌─ Local Machine (source of truth) ─────────────────────┐
│  git push → github.com/geoffmcc/sidekick               │
│  ./deploy.ps1 → SSH into remote, git pull, restart     │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ Remote Machine (YOUR_REMOTE_IP) ─────────────────────────┐
│                                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  MCP Server  │  │  Dashboard   │  │ Agent Bridge │  │
│  │  :4097       │  │  :4098       │  │  :4099       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                  │                  │          │
│         └──────────────────┼──────────────────┘          │
│                            │                             │
│         ┌──────────────────▼──────────────┐              │
│         │        Ollama :11434            │              │
│         │     Model: phi3:mini (2.2GB)    │              │
│         └─────────────────────────────────┘              │
└────────────────────────────────────────────────────────┘
```

*The agent bridge also supports Groq cloud API — when `GROQ_API_KEY` is set, it uses Groq instead of Ollama for near-instant LLM responses.*

## Services & Tools

| Service | Port | Description |
|---------|------|-------------|
| **MCP Server** | 4097 | 49 tools: bash, read, write, list, search, git, notify, process, service, archive, cron, github, webhook, context, teach, store, get, list_projects, get_by_project, web_fetch, llm, transform, health, delay, snapshot, watch, secret, parse, diff, hash, validate, template, queue, retry, evolve, orchestrate, predict, debug_tool, fresheyes, batch, cache, summarize, filter, project, tail, diff_files, find, status, extract |
| **Dashboard** | 4098 | Web UI: system health, activity log, KV data, agent tasks |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (phi3:mini). Fallback when no `GROQ_API_KEY` |

All tools are exposed via the MCP server at `http://YOUR_REMOTE_IP:4097/mcp`.

### New Tools (v1.17) - Token Efficiency

- **`sidekick_batch`** — Execute multiple tool calls in one request to reduce API round-trips (max 20 per batch).
- **`sidekick_cache`** — Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL.
- **`sidekick_summarize`** — Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats.
- **`sidekick_filter`** — Filter file contents or directory listings by pattern, date, or size before returning.
- **`sidekick_project`** — Get complete project context in one call: KV entries, context tracking, recent logs, procedures.
- **`sidekick_tail`** — Tail recent log entries with filtering. Sources: log.jsonl, journalctl, or any file.
- **`sidekick_diff_files`** — Compare two files directly without reading both into context. Returns unified diff or summary.
- **`sidekick_find`** — Advanced file finder: search by name pattern, date range, size range, and content pattern.
- **`sidekick_status`** — Unified system status: services, disk, memory, load, uptime, top processes in one call.
- **`sidekick_extract`** — Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need.

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

## Understanding the Architecture

To avoid confusion, it's important to understand what each component is:

- **Sidekick** = The autonomous agent platform: remote machine + 37+ MCP tools + persistent memory + Dashboard + Agent Bridge + self-extending capabilities
- **The AI** = The assistant running in opencode (e.g., qwen, Claude, etc.) that uses Sidekick's platform
- **Agent Bridge** = Sidekick's autonomous agent that runs tasks independently via the Dashboard

When you call sidekick tools in opencode, you're executing commands on the remote machine. The AI makes the decisions; Sidekick provides the capabilities.

The Agent Bridge is a separate system that can run tasks autonomously, but it's not integrated into the main AI's workflow. It's accessed via the Dashboard's Agent tab or direct API calls.

**What Sidekick does NOT do (currently):**
- It does not provide multi-AI collaboration (the main AI cannot consult the Agent Bridge and get responses back)
- It does not make decisions on its own (the AI in opencode makes all decisions)
- It is not a separate AI entity (it's infrastructure that the AI uses)

## Security

| Layer | Measure |
|-------|---------|
| **MCP Server** | Bearer token auth + IP whitelist (`SIDEKICK_ALLOWED_IPS`) + dangerous command blocklist |
| **Dashboard** | HTTP Basic Auth (`SIDEKICK_DASHBOARD_USER`/`PASS`) + rate limiting + CSRF protection + audit logging |
| **Agent Bridge** | Binds to `127.0.0.1` only, accessible exclusively through the dashboard proxy |
| **Sidekick user** | Sudo restricted to service management commands only (no wildcard `ALL`) |
| **Infrastructure** | SSH key-only, fail2ban, UFW, unattended-upgrades, `.env` file permissions locked to owner |
| **Data Redaction** | All tool outputs automatically redact SSH keys, GitHub tokens, API keys, passwords, database URLs, etc. |

The dashboard auth and IP whitelist are disabled by default (empty env var = no restriction). Set them in `.env` before exposing to the internet.

## Dashboard & Agent Bridge

### Dashboard

Open `http://YOUR_REMOTE_IP:4098/` in a browser.

- **System** — uptime, CPU, memory, disk, LLM status, service indicators (MCP, Agent, Ollama)
- **Activity** — live tool call log with source badges (mcp/agent/dashboard)
- **Data** — KV store contents with project filtering, age filtering, and expandable previews
- **Config** — environment variables (sensitive values redacted)
- **Agent** — submit tasks for the AI agent to execute autonomously

### Agent Bridge

The agent at `:4099` takes a natural-language goal and runs an autonomous loop:

1. Sends goal + tool definitions to the LLM (Groq cloud or local Ollama)
2. LLM responds with a tool call decision
3. Bridge executes the tool via MCP
4. Feeds result back to LLM
5. Repeats until the task is complete

#### Agent API

```bash
# Start a task
curl -X POST http://YOUR_REMOTE_IP:4099/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"goal": "check disk usage and store the result"}'

# Stream progress (SSE)
curl http://YOUR_REMOTE_IP:4099/api/agent/stream/{taskId}

# View history
curl http://YOUR_REMOTE_IP:4099/api/agent/history
```

## Setting Up AGENTS.md

> **This is the most important step.** Without this file, Sidekick is just a tool server. With it, Sidekick's tools and instructions are loaded into every opencode session.

Create or edit `~/.config/opencode/AGENTS.md` with the following structure (replace placeholders with your values):

~~~markdown
# Sidekick Configuration

## Connection
- IP: YOUR_REMOTE_IP
- MCP Server: port 4097
- Dashboard: port 4098
- Agent Bridge: port 4099

## Credentials
- GitHub token stored in KV key: `github_token`
- Use `sidekick_get("github_token")` to retrieve it for GitHub API calls

## Usage
- `sidekick_bash` — Run commands on the remote machine
- `sidekick_store` / `sidekick_get` — Persistent KV storage
- `sidekick_read` / `sidekick_write` — File operations
- `sidekick_git` — Git operations
- `task` subagent — Delegate complex multi-step tasks
~~~

**opencode reads this file automatically on every session start.** No plugins, no hooks, no manual loading — just a markdown file in the right place.

For the full AGENTS.md template with detailed usage guidelines, see [`AGENTS.md`](AGENTS.md) in this repo.

## Daily Workflow

```powershell
# 1. Edit code in src/
# 2. Commit and push
git add -A
git commit -m "what you changed"
git push

# 3. Deploy (Windows)
.\deploy.ps1 -IP "YOUR_REMOTE_IP"

# Or deploy (Linux/Mac)
./deploy.sh YOUR_REMOTE_IP
```

Or SSH directly to pull:
```bash
ssh sidekick@YOUR_REMOTE_IP
cd /home/sidekick/sidekick
git pull
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

## Configuration

To change environment variables (ports, API keys, max iterations, etc.):

```powershell
# 1. Edit .env locally
notepad .env

# 2. Deploy (syncs .env to remote and restarts services)
.\deploy.ps1 -IP "YOUR_REMOTE_IP"
```

The deploy script automatically syncs `.env` to the remote machine if it exists locally. No SSH required for config changes.

### Deploy Script Options

| Option | Description |
|--------|-------------|
| `-IP` | Remote machine IP address (default: `192.168.1.10`) |
| `-InitialUser` | Initial SSH user for bootstrap (e.g., ubuntu, admin, root) |

**First deploy:** The script prompts for the initial SSH user if not provided, then prompts for their password once. It then bootstraps the VM (creates sidekick user, installs Node.js, configures sudoers, installs services, installs SSH key, and opens firewall ports). After that, deploys are fully automated with no password required.

**Automation/CI:** Specify the initial user with `-InitialUser` to skip the interactive prompt:
```powershell
# Windows
.\deploy.ps1 -IP "192.168.1.10" -InitialUser "ubuntu"

# Linux/Mac
./deploy.sh -IP 192.168.1.10 -InitialUser ubuntu
```

### Security Model

The deploy script follows a two-phase security approach:

1. **First deploy (password required):** The script SSHs as the initial user (ubuntu/admin/root) and bootstraps the VM using SSH ControlMaster for connection multiplexing. This creates the sidekick user, installs Node.js, configures sudoers, installs systemd services, installs your SSH key, and opens firewall ports. All privileged operations require the initial user's password (prompted once via SSH ControlMaster).

2. **Subsequent deploys (no password):** The script SSHs as the sidekick user using SSH key authentication. Only minimal sudo permissions are used for service management (start/stop/restart/status) and log viewing. The sudoers file restricts the sidekick user to only these specific commands:
   - `systemctl start/stop/restart/status sidekick-*`
   - `journalctl -u sidekick-*`
   - `ufw allow 4097/4098/4099`

This follows the principle of least privilege: after initial setup, the sidekick user cannot reload systemd, enable/disable services, or modify the system in any way beyond managing the Sidekick services.

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDEKICK_API_KEY` | — | API key for MCP server auth |
| `SIDEKICK_ALLOWED_IPS` | — | Comma-separated IP whitelist for MCP server (empty = allow all) |
| `SIDEKICK_PORT` | 4097 | MCP server port |
| `SIDEKICK_DASHBOARD_PORT` | 4098 | Dashboard port |
| `SIDEKICK_AGENT_PORT` | 4099 | Agent bridge port |
| `SIDEKICK_DASHBOARD_USER` | — | Dashboard basic auth username (empty = disabled) |
| `SIDEKICK_DASHBOARD_PASS` | — | Dashboard basic auth password (empty = disabled) |
| `SIDEKICK_DATA_DIR` | `./data` | Data directory for logs, KV, conversations |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API URL (local fallback) |
| `GROQ_API_KEY` | — | Groq API key for cloud LLM (empty = use local Ollama) |
| `GROQ_MODEL` | `llama3-8b-8192` | Groq model name |
| `SIDEKICK_MAX_ITERATIONS` | `15` | Max agent loop iterations (safety limit) |

## Project Structure

```
├── src/
│   ├── tools.js        Shared tool handlers (extracted from index.js)
│   ├── index.js        MCP server (session-aware transport management)
│   ├── dashboard.js    Dashboard web UI (source tagging, Font Awesome icons)
│   ├── agent.js        Agent bridge (LLM tool-use loop, direct tool calls)
│   └── redact.js       Sensitive data redaction
├── scripts/
│   └── bootstrap.sh    VM bootstrap script (creates user, installs Node.js, etc.)
├── systemd/
│   ├── sidekick-mcp.service       MCP server systemd unit
│   ├── sidekick-dashboard.service Dashboard systemd unit
│   ├── sidekick-agent.service     Agent bridge systemd unit
│   └── sidekick-sudoers           Sudoers config for sidekick user
├── data/               Runtime data (on remote: logs, KV, conversations)
├── deploy.ps1          Deploy script (Windows)
├── deploy.sh           Deploy script (Linux/Mac)
├── .env.example        Environment variable template
├── AGENTS.md           opencode subagent config
├── CONTEXT.md          Project context and session notes
└── opencode.json       opencode MCP server config
```

## Troubleshooting

**Deploy script fails with "SSH key not found":** The script will automatically generate an SSH key if one doesn't exist at `~/.ssh/sidekick`.

**Deploy script fails with SSH connection error:** On first deploy, you'll need to install the SSH key. The script will prompt you for the sidekick password automatically.

**Deploy script fails with "sudoers setup failed":** Ensure the sidekick user exists on the remote machine and has sudo access. The script will prompt for the password to configure passwordless sudo for service management.

**MCP connection issues:** If you see "Server not initialized" errors, restart the MCP service:
```bash
sudo systemctl restart sidekick-mcp
```

**Dashboard won't load:** Check that the dashboard service is running:
```bash
sudo systemctl status sidekick-dashboard
```

**Services not starting:** Check the logs:
```bash
sudo journalctl -u sidekick-mcp -n 50
sudo journalctl -u sidekick-dashboard -n 50
sudo journalctl -u sidekick-agent -n 50
```

## Get Started

1. Clone the repo
2. Copy `.env.example` → `.env` and fill in your values
3. Run `.\deploy.ps1 -IP "YOUR_REMOTE_IP"` (Windows) or `./deploy.sh YOUR_REMOTE_IP` (Linux/Mac)
4. Enter the sidekick password when prompted (first deploy only)
5. Open `http://YOUR_REMOTE_IP:4098/` and explore your new autonomous agent platform

That's it. Sidekick is live.

---

**License:** MIT · See [LICENSE](LICENSE) for details.

**Contributing:** PRs welcome.

**Issues:** [Open one](https://github.com/geoffmcc/sidekick/issues) if you find a bug or have a feature request.
