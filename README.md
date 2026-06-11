# Sidekick

A remote VPS agent system with persistent storage, 37 MCP tools, and an autonomous agent bridge.

**How?** A single `AGENTS.md` file that opencode reads on every session start. No plugins, no hooks — just markdown.

> **Note:** This project was developed using its own remote execution tools — the AI assistant used Sidekick's infrastructure to help build and test the very system it runs on.

<!-- TODO: Add dashboard screenshot -->
<!-- TODO: Add agent loop GIF -->

## Quick Start

**What you need:** Node.js 18+, a remote machine with SSH access (VPS, home server, Raspberry Pi), Git, ~15 minutes.

```powershell
# Clone the repo
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick

# Copy env template and edit
copy .env.example .env
# Edit .env with your API key and settings

# Deploy (Windows)
.\deploy.ps1

# Or deploy (Linux/Mac)
./deploy.sh
```

Open `http://YOUR_VPS_IP:4098/` in a browser. That's it — Sidekick is live.

## How It Works

Every time you open opencode, it automatically reads `~/.config/opencode/AGENTS.md` and loads whatever instructions are in it into the AI's context. Sidekick provides the infrastructure — remote execution tools, persistent memory, and an autonomous agent — that the AI can use.

1. **You open opencode** — it reads `AGENTS.md`
2. **Sidekick's tools and instructions are loaded** — the AI now knows about the remote machine, the tools, and how to use them
3. **You work** — the AI can call sidekick tools to execute commands on the remote machine, store/retrieve persistent data, or you can submit tasks to the autonomous Agent Bridge via the dashboard
4. **Session ends** — but anything stored in Sidekick's KV persists for next time

Sidekick is the infrastructure. The AI (running in opencode) uses that infrastructure to help you work. Without `AGENTS.md`, the AI doesn't know Sidekick exists. With it, the AI has persistent remote capabilities.

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
┌─ Remote Machine (YOUR_VPS_IP) ─────────────────────────┐
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
| **MCP Server** | 4097 | 37 tools: bash, read, write, list, search, git, notify, process, service, archive, cron, github, webhook, context, teach, store, get, list_projects, get_by_project, web_fetch, llm, transform, health, delay, snapshot, watch, secret, parse, diff, hash, validate, template, queue, retry, evolve, orchestrate, predict |
| **Dashboard** | 4098 | Web UI: system health, activity log, KV data, agent tasks |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (phi3:mini). Fallback when no `GROQ_API_KEY` |

All tools are exposed via the MCP server at `http://YOUR_VPS_IP:4097/mcp`.

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

- **Sidekick** = The infrastructure: remote machine + MCP tools + KV store + Dashboard + Agent Bridge
- **The AI** = The assistant running in opencode (e.g., qwen, Claude, etc.) that uses Sidekick tools
- **Agent Bridge** = A separate autonomous AI (Groq/Ollama) that runs tasks independently via the Dashboard

When you call sidekick tools in opencode, you're executing commands on the remote VPS. The AI makes the decisions; Sidekick provides the capabilities.

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

Open `http://YOUR_VPS_IP:4098/` in a browser.

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
curl -X POST http://YOUR_VPS_IP:4099/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"goal": "check disk usage and store the result"}'

# Stream progress (SSE)
curl http://YOUR_VPS_IP:4099/api/agent/stream/{taskId}

# View history
curl http://YOUR_VPS_IP:4099/api/agent/history
```

## Setting Up AGENTS.md

> **This is the most important step.** Without this file, Sidekick is just a tool server. With it, Sidekick's tools and instructions are loaded into every opencode session.

Create or edit `~/.config/opencode/AGENTS.md` with the following structure (replace placeholders with your values):

~~~markdown
# Sidekick Configuration

## Connection
- IP: YOUR_VPS_IP
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
.\deploy.ps1

# Or deploy (Linux/Mac)
./deploy.sh
```

Or SSH directly to pull:
```bash
ssh sidekick@YOUR_VPS_IP
cd /home/sidekick/mcp-sidekick
git pull
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

## Configuration

To change environment variables (ports, API keys, max iterations, etc.):

```powershell
# 1. Edit .env locally
notepad .env

# 2. Deploy (syncs .env to remote and restarts services)
.\deploy.ps1
```

The deploy script automatically syncs `.env` to the remote machine if it exists locally. No SSH required for config changes.

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
├── data/               Runtime data (on remote: logs, KV, conversations)
├── deploy.ps1          Deploy script (Windows)
├── deploy.sh           Deploy script (Linux/Mac)
├── .env.example        Environment variable template
├── AGENTS.md           opencode subagent config
├── CONTEXT.md          Project context and session notes
└── opencode.json       opencode MCP server config
```

## Troubleshooting

**MCP connection issues:** If you see "Server not initialized" errors, restart the MCP service:
```bash
sudo systemctl restart sidekick-mcp
```

**Dashboard won't load:** Check that the dashboard service is running:
```bash
sudo systemctl status sidekick-dashboard
```

**Deploy script fails:** Ensure SSH key authentication is set up and the remote machine is reachable.

## Get Started

1. Clone the repo
2. Copy `.env.example` → `.env` and fill in your values
3. Run `./deploy.ps1` (Windows) or `./deploy.sh` (Linux/Mac)
4. Open `http://YOUR_VPS_IP:4098/` and explore your new remote AI infrastructure

That's it. Sidekick is live.

---

**License:** MIT · See [LICENSE](LICENSE) for details.

**Contributing:** PRs welcome.

**Issues:** [Open one](https://github.com/geoffmcc/sidekick/issues) if you find a bug or have a feature request.
