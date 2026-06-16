# Sidekick

**Autonomous Agent Platform**

A self-hosted AI agent platform with persistent memory, 92+ MCP tools, knowledge base, and the ability to extend itself. Runs on your remote machine, learns from your workflow, and grows its own capabilities—no code changes required.

**How?** A single `AGENTS.md` file that opencode reads on every session start. No plugins, no hooks — just markdown.

![Sidekick Dashboard](docs/screenshots/dashboard-system.png)

> **Note:** This project was developed using its own remote execution tools — the AI assistant used Sidekick's infrastructure to help build and test the very system it runs on.

## Quick Start

**What you need:** Node.js 22+, a remote Ubuntu/Debian machine with SSH access (VPS, home server, Raspberry Pi), Git, ~15 minutes.

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

**Optional: Install full infrastructure** (Docker, databases, media tools, etc.):
```bash
# SSH into your remote machine
ssh sidekick@YOUR_REMOTE_IP

# Run the setup script
sudo bash scripts/setup-tools.sh
```

This installs PostgreSQL, Redis, Qdrant, InfluxDB, Grafana, and many other tools. See [Optional Infrastructure](#optional-infrastructure) for details.

**Subsequent deploys** are fully automated — no password required.

**For automation/CI**, specify the initial user with `-InitialUser`:
```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -InitialUser "ubuntu"

# Linux/Mac
./deploy.sh -IP YOUR_REMOTE_IP -InitialUser ubuntu
```

**Airgap/Offline Deploy** — If your remote server cannot reach GitHub (firewall, air-gapped network, etc.), use the `--scp` flag to sync files individually via SSH:
```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -Scp

# Linux/Mac
./deploy.sh -IP YOUR_REMOTE_IP --scp
```
This uses the original SCP-based approach, copying files one-by-one from your local machine. No internet access required on the remote server.

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

### 📚 Knowledge Base
All documentation, best practices, and project context stored in a searchable database. The AI can query the knowledge base instead of re-reading files, saving tokens and improving accuracy.

### 📊 Built-in Metrics & Monitoring
Comprehensive metrics collection with Grafana dashboards:
- System health (CPU, memory, disk, load)
- Tool usage analytics (call counts, success rates, duration)
- Service status monitoring
- Database performance metrics
- Docker container stats
- Ollama LLM metrics

### 🔄 Self-Extending Capabilities
Teach Sidekick new procedures, and it can generate its own tools. The `sidekick_teach` tool lets you describe a workflow in natural language, and Sidekick creates the implementation. It's not just using tools—it's building them.

### 🤖 True Autonomous Operation
The Agent Bridge runs independently from your main AI session. Submit a complex task via the dashboard, and Sidekick will plan, execute, and iterate until it's done—without you babysitting each step.

### 🔒 Security-First Design
Every tool output is automatically scanned and redacted for sensitive data (API keys, tokens, passwords). The dashboard has rate limiting, CSRF protection, and audit logging. The agent bridge is isolated and only accessible through the dashboard.

### 🛠️ 92+ Specialized Tools
Not just bash and file operations. Sidekick includes tools for:
- GitHub integration (PRs, issues, releases)
- Service and process management
- Scheduled tasks and monitoring
- Data transformation and validation
- Multi-agent orchestration
- Encrypted credential management
- Network diagnostics and troubleshooting
- Incident response and forensics
- Operational runbooks and procedures
- Dependency analysis and impact assessment
- Database operations (query, backup, restore, search, migrations)
- Media processing (OCR, transcription, video/audio conversion)
- Networking (Cloudflare tunnels, WireGuard, Nginx)
- Metrics collection and visualization
- Knowledge base management
- And much more

**The result:** Sidekick isn't just a tool server—it's an autonomous platform that learns, adapts, and grows with your workflow.

## Self-Debugging in Action

Sidekick used its own tools to help develop itself. Here's the AI agent debugging Sidekick from within opencode:

**Testing the debug tool's store/cleanup/recall cycle:**
![Debug tool testing](docs/screenshots/debug-tool-testing.png)

**Diagnosing its own hallucination problem with `sidekick_fresheyes`:**
![Fresh eyes analysis](docs/screenshots/fresh-eyes-analysis.png)

**Investigating why the self-improvement tool isn't working:**
![Evolve debugging](docs/screenshots/evolve-debugging.png)

## What You Can Achieve

| Capability | How | Why AGENTS.md Matters |
|---|---|---|
| **Remote code execution** | `sidekick_bash` runs commands on a persistent remote machine | Instructions tell the AI when and how to use it |
| **Persistent memory across sessions** | `sidekick_store` / `sidekick_get` — KV storage that survives restarts | AI knows which keys to store and retrieve |
| **Knowledge base queries** | `sidekick_knowledge` — Search structured documentation | AI queries DB instead of re-reading files |
| **Metrics & monitoring** | Grafana dashboards at `:3000` + Metrics tab in dashboard | Real-time system health, tool usage, service status |
| **Autonomous multi-step tasks** | Agent bridge at `:4099` plans and executes until done | AI knows to delegate complex work to the agent |
| **Code review** | Ask the AI to review diffs using remote execution tools | Decision tree in AGENTS.md tells the AI *when* to use sidekick tools for review |
| **GitHub integration** | Stored tokens let sidekick create repos, push code, manage PRs | AGENTS.md tells the AI where to find credentials |
| **Database operations** | `sidekick_db_*` tools for SQLite and PostgreSQL | Query, backup, restore, search, migrate databases |
| **Media processing** | `sidekick_ocr`, `sidekick_media`, `sidekick_transcribe` | OCR, video/audio conversion, transcription |
| **Networking** | `sidekick_tunnel`, `sidekick_wireguard`, `sidekick_nginx` | Cloudflare tunnels, VPN, reverse proxy |
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
│  ┌─────────────────────────▼──────────────────────────┐ │
│  │              Data & Services Layer                  │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │ │
│  │  │ SQLite   │  │ Redis    │  │ Qdrant   │         │ │
│  │  │ (main DB)│  │ (cache)  │  │ (vector) │         │ │
│  │  └──────────┘  └──────────┘  └──────────┘         │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │ │
│  │  │InfluxDB  │  │ Grafana  │  │ Ollama   │         │ │
│  │  │ :8086    │  │ :3000    │  │ :11434   │         │ │
│  │  └──────────┘  └──────────┘  └──────────┘         │ │
│  └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

*The agent bridge also supports Groq cloud API — when `GROQ_API_KEY` is set, it uses Groq instead of Ollama for near-instant LLM responses.*

### Data Layer

- **SQLite** — Primary database for KV store, tool logs, knowledge base, and metadata
- **Redis** — Session-scoped caching with TTL support
- **Qdrant** — Vector database for semantic search and embeddings
- **InfluxDB** — Time-series metrics collection (system health, tool usage, service status)
- **Grafana** — Metrics visualization with 6 pre-built dashboards

### LLM Support

- **Ollama** (local) — Multiple models available:
  - `qwen2.5-coder:7b` — Default, optimized for code tasks
  - `llama3.1:8b` — General purpose reasoning
  - `nomic-embed-text` — Embedding model for semantic search
- **Groq** (cloud) — Fast inference when `GROQ_API_KEY` is set

## Services & Tools

| Service | Port | Description |
|---------|------|-------------|
| **MCP Server** | 4097 | 92+ tools across 19 categories (see database for full list) |
| **Dashboard** | 4098 | Web UI: system health, activity log, KV data, agent tasks, tool catalog, metrics |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (qwen2.5-coder:7b, llama3.1:8b, nomic-embed-text) |
| **Redis** | 6379 | Session-scoped caching with TTL |
| **Qdrant** | 6333 | Vector database for semantic search |
| **InfluxDB** | 8086 | Time-series metrics (system health, tool usage, service status) |
| **Grafana** | 3000 | Metrics visualization with 6 pre-built dashboards |

All tools are exposed via the MCP server at `http://YOUR_REMOTE_IP:4097/mcp`.

### Tool Categories

Tools are organized into 19 categories:
- **Core** — bash, read, write, list, search, web_fetch, llm, respond
- **Storage** — store, get, list_projects, get_by_project, redis
- **Database** — db_schema, db_query, db_stats, db_backup, db_restore, db_export, db_search, db_migrate, db_diff, analytics
- **Git & GitHub** — git, github
- **Services** — process, service
- **Scheduling** — cron, delay
- **Communication** — notify, webhook
- **Context & Learning** — context, teach, embed, ollama, knowledge
- **Data Pipeline** — transform, parse, diff, hash, validate, template, extract, anonymize, diff_files
- **Monitoring** — health, status, watch, baseline, snapshot, timeline, black_box, netdiag, metrics
- **Workflow** — queue, retry, orchestrate, runbook
- **Meta** — evolve, predict, debug_tool, fresheyes
- **Efficiency** — batch, cache, summarize, filter, project, tail, find
- **Security** — secret, sandbox
- **Networking** — tunnel, wireguard, nginx
- **Development** — changelog, depend
- **Reliability** — circuit
- **Archive** — archive
- **Media** — ocr, media, transcribe, download

Query the database for the complete tool list:
```sql
SELECT t.name, t.description, t.risk, tc.name as category
FROM tools t
LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
WHERE t.enabled = 1 AND t.deprecated = 0
ORDER BY tc.sort_order, t.name
```

## Understanding the Architecture

To avoid confusion, it's important to understand what each component is:

- **Sidekick** = The autonomous agent platform: remote machine + 92+ MCP tools + persistent memory + knowledge base + Dashboard + Agent Bridge + metrics & monitoring + self-extending capabilities
- **The AI** = The assistant running in opencode (e.g., qwen, Claude, etc.) that uses Sidekick's platform
- **Agent Bridge** = Sidekick's autonomous agent that runs tasks independently via the Dashboard
- **Knowledge Base** = Structured documentation stored in SQLite, searchable via `sidekick_knowledge`
- **Metrics System** = InfluxDB + Grafana for system health, tool usage, and service monitoring

When you call sidekick tools in opencode, you're executing commands on the remote machine. The AI makes the decisions; Sidekick provides the capabilities.

The Agent Bridge is a separate system that can run tasks autonomously, but it's not integrated into the main AI's workflow. It's accessed via the Dashboard's Agent tab or direct API calls.

The Knowledge Base replaces the need for large markdown files. Instead of re-reading AGENTS.md or CONTEXT.md, the AI queries the database for specific information, saving tokens and improving accuracy.

**What Sidekick does NOT do (currently):**
- It does not provide multi-AI collaboration (the main AI cannot consult the Agent Bridge and get responses back)
- It does not make decisions on its own (the AI in opencode makes all decisions)
- It is not a separate AI entity (it's infrastructure that the AI uses)

## Security

| Layer | Measure |
|-------|---------|
| **MCP Server** | Bearer token auth + IP whitelist (`SIDEKICK_ALLOWED_IPS`) + dangerous command blocklist + configurable tool policy |
| **Dashboard** | HTTP Basic Auth (`SIDEKICK_DASHBOARD_USER`/`PASS`) + rate limiting + CSRF protection + audit logging + tool policy visibility |
| **Agent Bridge** | Binds to `127.0.0.1` only, accessible exclusively through the dashboard proxy |
| **Sidekick user** | Sudo restricted to service management commands only (no wildcard `ALL`) |
| **Infrastructure** | SSH key-only, fail2ban, UFW, unattended-upgrades, `.env` file permissions locked to owner |
| **Data Redaction** | All tool outputs automatically redact SSH keys, GitHub tokens, API keys, passwords, database URLs, etc. |

The dashboard auth and IP whitelist are disabled by default (empty env var = no restriction). Set them in `.env` before exposing to the internet. For shared or public-facing deployments, set `SIDEKICK_TOOL_POLICY=restricted` and explicitly allow only the high-risk tools your workflow needs.

**⚠️ Evolve Tool Warning:** The `sidekick_evolve` tool can automatically implement approved proposals (creating documentation files and teaching procedures). If your tool policy is `open`, evolve will execute these implementations without additional approval. For shared or public-facing deployments, set `SIDEKICK_TOOL_POLICY=restricted` to require explicit tool allowlisting before evolve can create or use tools.

## Dashboard & Agent Bridge

### Dashboard

Open `http://YOUR_REMOTE_IP:4098/` in a browser.

- **System** — uptime, CPU, memory, disk, LLM status, service indicators (MCP, Agent, Ollama)
- **Activity** — live tool call log with source badges (mcp/agent/dashboard)
- **Data** — KV store contents with project filtering, age filtering, and expandable previews
- **Database** — schema browser, query editor, full-text search, migration management
- **Config** — environment variables (sensitive values redacted)
- **Agent** — submit tasks for the AI agent to execute autonomously
- **Tools** — browsable catalog of all 92+ tools with search, category filtering, policy status, risk labels, and detailed argument info
- **Metrics** — embedded Grafana dashboards for system health, tool analytics, database performance, Docker containers, and Ollama metrics

### Metrics & Monitoring

Sidekick includes comprehensive metrics collection and visualization:

**Metrics Collection** (runs every minute via cron):
- System health: CPU, memory, disk, load average
- Tool usage: call counts, success rates, duration stats per tool
- Service status: MCP, Dashboard, Agent health

**Grafana Dashboards** (6 pre-built):
1. **Sidekick Overview** — High-level system metrics and tool usage
2. **Tool Analytics** — Per-tool performance metrics with dynamic selectors
3. **System Health** — CPU, memory, disk usage over time
4. **Database Performance** — Query times, connection counts, cache hit ratios
5. **Docker Containers** — Container resource usage and health
6. **Ollama** — LLM request counts, response times, token usage

Access Grafana directly at `http://YOUR_REMOTE_IP:3000/` (credentials: sidekick/sidekick)

### Knowledge Base

Sidekick includes a structured knowledge base for storing and retrieving project documentation:

- **36+ entries** across categories: best-practices, architecture, operations, protocols
- **Full-text search** with semantic similarity
- **Auto-migration** from AGENTS.md and CONTEXT.md
- **Tool**: `sidekick_knowledge` for search, get, list, add, update, delete

Example queries:
```bash
# Search for debugging best practices
sidekick_knowledge action="search" query="debugging"

# List all architecture entries
sidekick_knowledge action="list" category="architecture"

# Get specific entry
sidekick_knowledge action="get" id=18
```

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

Sidekick uses a **knowledge-base-first architecture**. Instead of storing all documentation in large markdown files, AGENTS.md points to the knowledge base where all information is stored.

The AGENTS.md file includes:
- Connection info (IP, ports, SSH)
- Knowledge base query examples
- Tool query examples (SQL to list tools from database)
- Basic usage instructions

**opencode reads this file automatically on every session start.** No plugins, no hooks, no manual loading — just a markdown file in the right place.

For the full AGENTS.md template, see [`AGENTS.md`](AGENTS.md) in this repo.

### Knowledge Base Categories

The knowledge base includes entries in these categories:
- **best-practices** — Interaction policies, debugging, tool selection, token efficiency
- **architecture** — Services, DB-first architecture, monitoring, tooling
- **operations** — Deployment, configuration, security, troubleshooting
- **protocols** — Context recall and other protocols

Query the knowledge base:
```bash
# List all categories
sidekick_knowledge action="list"

# Search for specific topics
sidekick_knowledge action="search" query="deployment"

# Get entries by category
sidekick_knowledge action="list" category="best-practices"
```

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

## Optional Infrastructure

Sidekick can be extended with additional services for enhanced capabilities:

### Database Services

**PostgreSQL** (optional, alongside SQLite):
```bash
sudo systemctl start sidekick-postgres
```
- Full SQL database for complex queries and relational data
- Accessible via `sidekick_db_query` with `database="postgres"`

**Redis** (session caching):
```bash
sudo systemctl start sidekick-redis
```
- Session-scoped caching with TTL
- Automatic fallback to in-memory cache if unavailable

**Qdrant** (vector database):
```bash
sudo systemctl start sidekick-qdrant
```
- Semantic search for `sidekick_context` tool
- Embedding-based similarity search

### Metrics & Monitoring

**InfluxDB** (time-series database):
```bash
sudo systemctl start sidekick-influxdb
```
- Stores system metrics, tool usage, service status
- Metrics collected every minute via cron

**Grafana** (visualization):
```bash
sudo systemctl start sidekick-grafana
```
- 6 pre-built dashboards
- Accessible at `http://YOUR_REMOTE_IP:3000/` (sidekick/sidekick)
- Embedded in Dashboard's Metrics tab

### Install All Services

Run the setup script to install the full tool stack:
```bash
sudo bash scripts/setup-tools.sh
```

This installs:
- Docker and Docker Compose
- PostgreSQL, Redis, Qdrant, InfluxDB, Grafana
- Media tools (ffmpeg, ImageMagick, Tesseract OCR)
- Development tools (Go, Python packages)
- Networking tools (Cloudflare tunnels, WireGuard, Nginx)
- And more...

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
| `SIDEKICK_TOOL_POLICY` | `open` | Tool policy mode: `open` or `restricted` |
| `SIDEKICK_BLOCKED_TOOLS` | — | Comma-separated global blocklist of tool names or risk selectors |
| `SIDEKICK_ALLOWED_TOOLS` | — | Comma-separated global allowlist of tool names or risk selectors |
| `SIDEKICK_AGENT_TOOL_POLICY` | — | Source-specific tool policy override for the Agent Bridge |
| `SIDEKICK_MCP_TOOL_POLICY` | — | Source-specific tool policy override for MCP clients |
| `SIDEKICK_DASHBOARD_TOOL_POLICY` | — | Source-specific tool policy override for dashboard-originated calls |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API URL (local fallback) |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | Default Ollama model |
| `GROQ_API_KEY` | — | Groq API key for cloud LLM (empty = use local Ollama) |
| `GROQ_MODEL` | `llama3-8b-8192` | Groq model name |
| `SIDEKICK_MAX_ITERATIONS` | `15` | Max agent loop iterations (safety limit) |
| `SIDEKICK_POSTGRES_URL` | `postgresql://sidekick:sidekick@127.0.0.1:5432/sidekick` | PostgreSQL connection string |
| `SIDEKICK_REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string |
| `SIDEKICK_QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant vector DB URL |
| `SIDEKICK_INFLUX_URL` | `http://127.0.0.1:8086` | InfluxDB URL |
| `SIDEKICK_INFLUX_TOKEN` | `sidekick-influx-token` | InfluxDB authentication token |
| `SIDEKICK_INFLUX_ORG` | `sidekick` | InfluxDB organization |
| `SIDEKICK_INFLUX_BUCKET` | `sidekick` | InfluxDB bucket for metrics |

## Project Structure

```
├── src/
│   ├── tools.js        Shared tool handlers (92+ tools)
│   ├── index.js        MCP server (session-aware transport management)
│   ├── dashboard.js    Dashboard web UI (8 tabs including Metrics)
│   ├── agent.js        Agent bridge (LLM tool-use loop, direct tool calls)
│   ├── redact.js       Sensitive data redaction
│   ├── db.js           SQLite database layer
│   ├── pg.js           PostgreSQL support
│   ├── redis.js        Redis client for caching
│   └── qdrant.js       Qdrant vector DB client for semantic search
├── scripts/
│   ├── bootstrap.sh    VM bootstrap script (creates user, installs Node.js, etc.)
│   ├── setup-tools.sh  Server tooling setup (Docker, databases, media tools, etc.)
│   ├── collect-metrics.js  Metrics collection script (runs via cron)
│   └── parse-context.js    Migrate CONTEXT.md to knowledge base
├── systemd/
│   ├── sidekick-mcp.service       MCP server systemd unit
│   ├── sidekick-dashboard.service Dashboard systemd unit
│   ├── sidekick-agent.service     Agent bridge systemd unit
│   ├── sidekick-postgres.service  PostgreSQL Docker wrapper
│   ├── sidekick-redis.service     Redis Docker wrapper
│   ├── sidekick-qdrant.service    Qdrant Docker wrapper
│   ├── sidekick-influxdb.service  InfluxDB Docker wrapper
│   ├── sidekick-grafana.service   Grafana Docker wrapper
│   └── sidekick-sudoers           Sudoers config for sidekick user
├── docker/
│   └── docker-compose.yml  Docker services (Postgres, Redis, Qdrant, InfluxDB, Grafana)
├── grafana/
│   ├── provisioning/       Grafana auto-provisioning configs
│   └── dashboards/         6 pre-built Grafana dashboards
├── migrations/
│   ├── 001_initial_schema.sql  Initial database schema
│   └── 002_tool_registry.sql   Tool registry and knowledge base tables
├── data/               Runtime data (on remote: logs, KV, conversations, metrics)
├── deploy.ps1          Deploy script (Windows)
├── deploy.sh           Deploy script (Linux/Mac)
├── .env.example        Environment variable template
├── AGENTS.md           opencode subagent config (points to knowledge base)
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
