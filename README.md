# Sidekick

**Autonomous Agent Platform**

A self-hosted AI agent platform with 107 built-in MCP tools, persistent structured memory, searchable knowledge, autonomous workflows, and distributed model compute. Runs on your remote machine, keeps explicit project context across sessions, and can expose approved generated capabilities without modifying the built-in registry.

**How?** Connect a compatible MCP client to Sidekick, then optionally adapt the included `AGENTS.md` template so the client knows how to use its persistent tools and knowledge.

> **Note:** This project was developed using its own remote execution tools — the AI assistant used Sidekick's infrastructure to help build and test the very system it runs on.

## Refactor Status and Compatibility Disclosure

> **Full disclosure:** Sidekick's tool runtime is partway through a deliberate modular migration. The descriptor registry, centralized dispatcher, request-scoped context, schema validation, source-aware policy, approval enforcement, redaction, and audit logging are now the authoritative production execution path. However, most mature tool handlers still reside in `src/tools-legacy.js` behind compatibility adapters. New tool families belong under `src/tools/families/`, and legacy families are being extracted incrementally to preserve behavior and avoid a risky all-at-once rewrite. The execution and security boundary is modular today; complete implementation decomposition is not yet finished. See [`docs/tool-architecture.md`](docs/tool-architecture.md) for the current boundary and remaining migration work.

Canonical MCP tool names are unprefixed, such as `bash`, `knowledge`, and `compute_jobs`. The runtime still recognizes older `sidekick_`-prefixed names as compatibility aliases, but new documentation, policies, and integrations should use the bare names.

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
- Create the sidekick user and install Node.js 22
- Configure sudo permissions for service management
- Install and enable systemd services
- Install your SSH key for passwordless access
- Open firewall ports (if UFW is active)
- Deploy the application as a Git checkout at `/home/sidekick/sidekick` and start services

**Optional: Install full infrastructure** (Docker, databases, media tools, etc.):
```bash
# SSH into your remote machine
ssh sidekick@YOUR_REMOTE_IP

# Run the setup script
sudo bash scripts/setup-tools.sh
```

This installs PostgreSQL, Redis, Qdrant, InfluxDB, Grafana, and many other tools. See [Optional Infrastructure](#optional-infrastructure) for details.

**Subsequent deploys** are fully automated — no password required. Normal online deployments fetch `origin/main` from GitHub, fast-forward the remote `main` checkout, and verify that Git push is disabled with `git remote set-url --push origin DISABLED`.

**For automation/CI**, specify the initial user with `-InitialUser`:
```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -InitialUser "ubuntu"

# Linux/Mac
./deploy.sh -IP YOUR_REMOTE_IP -InitialUser ubuntu
```

**Airgap/Offline Deploy** — If your remote server cannot reach GitHub (firewall, air-gapped network, etc.), explicitly use the `--scp` flag to sync files individually via SSH:
```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -Scp

# Linux/Mac
./deploy.sh -IP YOUR_REMOTE_IP --scp
```
This copies files one-by-one from your local machine and does not create a Git working tree. No internet access is required on the remote server, but `ops deploy_current_main` requires the normal Git deployment model and will not silently fall back to SCP.

Open `http://YOUR_REMOTE_IP:4098/` in a browser. That's it — Sidekick is live.

## How It Works

Sidekick exposes its tool catalog through the Model Context Protocol. Any compatible MCP client can connect to the Streamable HTTP endpoint with a bearer token. The included `AGENTS.md` file is an optional, portable bootstrap template for clients that support persistent project or agent instructions.

1. **An MCP client connects** — it authenticates to the Sidekick MCP server on port 4097.
2. **Sidekick publishes the available tool catalog** — policy, risk, and approval rules are applied for the request source.
3. **The assistant or agent calls tools** — it can operate the remote machine, query knowledge, store durable context, or submit work to the Agent Bridge.
4. **State persists** — approved memories, project data, workflows, logs, and knowledge remain available after the client session ends.

Sidekick provides the persistent infrastructure; the connected assistant or agent decides when and how to use it. Exact prompting and automatic instruction-file loading depend on the MCP client.

## Usage

Exact invocation syntax varies by MCP client. At the protocol level, a direct call identifies a tool and supplies its arguments. For example:

```json
{
  "name": "knowledge",
  "arguments": {
    "action": "search",
    "query": "debugging"
  }
}
```

### Complex Multi-Step Tasks

A connected agent can combine multiple Sidekick tools to complete longer tasks. For example, an agent updating a stored project roadmap could:

1. Recall the current plan from persistent storage.
2. Inspect recent commits and CI results.
3. Update the plan with completion status and remaining work.
4. Store a handoff or revised plan for the next session.

The same workflow can emit notifications, create durable task records, or run through the Agent Bridge when autonomous execution is appropriate.

### Conversational Planning

Sidekick supports continuity across ordinary conversations because project facts, decisions, procedures, and handoffs can be retrieved in later sessions:

```text
you: "We stored a plan, but it is now out of date."
agent: "I found the current project roadmap and recent implementation history. I can reconcile the completed work and revise the remaining steps."
you: "Update it."
agent: [reviews current evidence, updates the roadmap, and stores the revised handoff]
```

### Debugging

Sidekick can combine source inspection, logs, database queries, service health, incident captures, and evidence-backed analysis to diagnose issues across the stack. Tool calls still pass through the same validation, policy, approval, redaction, and audit boundary.

### Dashboard

Open `http://YOUR_REMOTE_IP:4098/` for:
- System health monitoring
- Tool usage analytics and activity inspection
- Agent task submission and streaming
- Persistent data and structured memory management
- Approvals, tool catalog, Compute workers, jobs, and artifacts

## What Makes Sidekick Different?

Most MCP servers are just tool wrappers—they give AI access to specific APIs or services. Sidekick is fundamentally different:

### 🧠 Persistent Memory Across Sessions
Sidekick provides durable project memory through SQLite-backed KV, context, and structured memory tables. Agents can explicitly store decisions, project facts, problems, patterns, and summaries, then retrieve them in later sessions by key, project, or context query. The Agent Bridge also records bounded, redacted structured memories for completed tasks and useful tool calls, then loads relevant remembered context before planning a new task.

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

### 🔄 Evidence-Driven Workflow Learning
Sidekick can learn repeated successful workflows from redacted tool telemetry. `teach` stores reusable procedures composed from existing tools. `evolve` mines repeated bounded workflows, infers safe parameters, validates the procedure, and only after explicit approval exposes trial or active generated capabilities as namespaced MCP tools such as `generated_<name>`.

### 🤖 True Autonomous Operation
The Agent Bridge runs independently from your main AI session. Submit a complex task via the dashboard, and Sidekick will plan, execute, and iterate until it's done—without you babysitting each step.

### 🖥️ Distributed Compute
Sidekick Compute enrolls authenticated worker agents and routes allowlisted `chat`, `generate`, and `embeddings` jobs across registered workers, providers, and models. It includes scoped worker credentials, job leases, progress, cancellation, retry/recovery, artifacts, health reporting, routing rules, and dashboard controls. It is intentionally not an arbitrary remote shell or a general-purpose GPU batch system.

### 🔒 Security-First Design
Every tool output is automatically scanned and redacted for sensitive data (API keys, tokens, passwords). The dashboard has rate limiting, CSRF protection, and audit logging. The agent bridge is isolated and only accessible through the dashboard.

### 🛠️ 107 Built-In Specialized Tools
Not just bash and file operations. Sidekick includes tools for:
- GitHub integration and read-only CI/check-run inspection
- Service and process management
- Scheduled tasks and monitoring
- Data transformation, validation, analytics, and evidence-backed reports
- Durable workflows, task sessions, handoffs, and orchestration
- Encrypted credential management
- Read-only configuration and secret exposure scanning
- Network diagnostics and troubleshooting
- Incident response and forensics
- Operational runbooks and procedures
- Dependency analysis and impact assessment
- Database operations (query, backup, restore, search, migrations)
- Media processing (OCR, transcription, video/audio conversion)
- Networking (Cloudflare tunnels, WireGuard, Nginx)
- Metrics collection and visualization
- Knowledge base and structured memory management
- Distributed allowlisted model jobs through enrolled Compute workers
- And much more

**The result:** Sidekick isn't just a tool server—it's an autonomous platform that learns, adapts, and grows with your workflow.

## Self-Debugging in Action

Sidekick has used its own tools to test storage and recall behavior, investigate agent failure patterns with `fresheyes`, and diagnose Evolve workflow problems. These checks use the same public tool surface, dispatcher, policy, approval, redaction, and audit paths available to other connected clients.

## What You Can Achieve

| Capability | How | Why agent guidance helps |
|---|---|---|
| **Remote code execution** | `bash` runs commands on a persistent remote machine | Instructions tell the AI when and how to use it |
| **Persistent memory across sessions** | `store` / `get` — KV storage that survives restarts | AI knows which keys to store and retrieve |
| **Knowledge base queries** | `knowledge` — Search structured documentation | AI queries DB instead of re-reading files |
| **Metrics & monitoring** | Grafana dashboards at `:3000` + Metrics tab in dashboard | Real-time system health, tool usage, service status |
| **Autonomous multi-step tasks** | Agent bridge at `:4099` plans and executes until done | AI knows to delegate complex work to the agent |
| **Code review** | Ask the AI to review diffs using remote execution tools | Decision tree in AGENTS.md tells the AI *when* to use sidekick tools for review |
| **GitHub integration** | `github` uses `GITHUB_TOKEN` or encrypted `secret` credentials | AGENTS.md tells the AI to query current credential procedures |
| **GitHub CI inspection** | `ci_status` reads check runs plus legacy statuses for a PR head, SHA, ref, or branch | AI can make CI decisions without relying on legacy status-only data |
| **Database operations** | `db_*` tools for SQLite and PostgreSQL | Query, backup, restore, search, migrate databases |
| **Media processing** | `ocr`, `media`, `transcribe` | OCR, video/audio conversion, transcription |
| **Networking** | `tunnel`, `wireguard`, `nginx` | Cloudflare tunnels, VPN, reverse proxy |
| **Web scraping from remote** | `web_fetch` bypasses local network restrictions | AI knows to use remote machine for fetching when needed |
| **LLM on demand** | Cloud Groq for speed, local Ollama as fallback | AI knows which to use and when |
| **Distributed model jobs** | `compute_*` manages enrolled workers, providers, models, routing, jobs, and artifacts | AI can route allowlisted inference work without exposing arbitrary worker-side shell execution |
| **File content search** | `search` uses ripgrep/grep for fast code search | AI can quickly find code patterns across the codebase |
| **Git operations** | `git` provides structured git commands | AI can check status, diff, log, commit, push, pull safely |
| **Notifications** | `notify` sends alerts to Discord, Slack, or email | AI can alert you when tasks complete or errors occur |
| **Process management** | `process` lists, monitors, and kills processes | AI can troubleshoot high CPU/memory or kill hung processes |
| **Service management** | `service` controls systemd services safely | AI can restart services, check status, view logs |
| **Archive operations** | `archive` creates/extracts tar.gz and zip files | AI can backup data, deploy archives, manage backups |
| **Scheduled tasks** | `cron` schedules recurring jobs via crontab | AI can set up automated health checks, backups, monitoring |
| **GitHub automation** | `github` manages PRs, issues, releases via API | AI can automate PR workflows, track issues, create releases |
| **Webhook integration** | `webhook` receives and stores external webhooks | AI can react to GitHub events, CI/CD pipelines, external alerts |
| **Persistent context** | `context` tracks projects, decisions, problems, patterns | AI can recall past context, get suggestions, maintain continuity across sessions |
| **Workflow learning** | `teach` stores procedures; `evolve` promotes validated repeated workflows into trial/active generated MCP tools | AI can reuse proven workflows without confusing proposals with callable tools |

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

*The Agent Bridge supports the Groq cloud API when `GROQ_API_KEY` is configured. Sidekick Compute workers are separate enrolled processes that connect to scoped `/compute/worker/*` routes on the MCP service; they are not additional always-on services inside the three-process core.*

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
| **MCP Server** | 4097 | 107 built-in tools across 20 categories; approved generated tools may add runtime entries |
| **Dashboard** | 4098 | Web UI for system health, activity, data, memory, approvals, tools, Compute, agent tasks, and metrics |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (qwen2.5-coder:7b, llama3.1:8b, nomic-embed-text) |
| **Redis** | 6379 | Session-scoped caching with TTL |
| **Qdrant** | 6333 | Vector database for semantic search |
| **InfluxDB** | 8086 | Time-series metrics (system health, tool usage, service status) |
| **Grafana** | 3000 | Metrics visualization with 6 pre-built dashboards |

All tools are exposed via the MCP server at `http://YOUR_REMOTE_IP:4097/mcp`.

### Tool Categories

The 107 built-in tools are organized into 20 categories:
- **Core** — bash, tools, read, write, list, search, web_fetch, llm, respond
- **Storage** — store, get, delete, resume, list_projects, get_by_project, redis
- **Database** — db_schema, db_query, db_stats, db_backup, db_restore, db_export, log_query, db_search, db_migrate, db_diff, analytics
- **Git & GitHub** — git, github, ci_status
- **Services** — process, service
- **Scheduling** — cron, delay
- **Communication** — notify, webhook
- **Context & Learning** — context, session, handoff, memory, teach, embed, ollama, memory_export, memory_import, memory_manage, sync_identity, sync_export, sync_import, sync_diff, knowledge
- **Data Pipeline** — transform, parse, diff, hash, validate, template, extract, anonymize, diff_files, insight_report
- **Monitoring** — health, status, watch, baseline, snapshot, timeline, black_box, netdiag, metrics
- **Workflow** — queue, retry, orchestrate, runbook, ops, mission
- **Meta** — evolve, predict, debug_tool, fresheyes
- **Efficiency** — batch, cache, summarize, filter, project, tail, find
- **Security** — secret, security_scan, sandbox
- **Networking** — tunnel, wireguard, nginx
- **Development** — changelog, depend
- **Reliability** — circuit
- **Archive** — archive
- **Media** — ocr, media, transcribe, download
- **Compute** — compute, compute_nodes, compute_providers, compute_models, compute_jobs, compute_route

### Black Box Incident Explorer

`black_box` stores profiled incident captures as structured SQLite records with source-level artifacts, observations, timelines, evidence-cited analysis, search, comparison, retention controls, and dashboard inspection. See [`docs/blackbox.md`](docs/blackbox.md) for profiles, schema, dashboard behavior, retention, export, and security notes.

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

- **Sidekick** = The self-hosted agent platform: 107 built-in MCP tools + persistent memory + knowledge base + Dashboard + Agent Bridge + metrics + approved generated capabilities + Sidekick Compute
- **The assistant or agent** = Any compatible MCP client, coding assistant, or automation agent that uses Sidekick's platform
- **Tool runtime** = The descriptor registry and dispatcher that validate, authorize, approve, execute, redact, and audit tool calls across MCP, dashboard, agent, scheduler, and generated-tool paths
- **Agent Bridge** = Sidekick's autonomous task runner, accessed through the Dashboard and API
- **Knowledge Base** = Structured documentation stored in SQLite, searchable via `knowledge`
- **Sidekick Compute** = The allowlisted worker/provider/model/job system for distributed inference workloads
- **Metrics System** = InfluxDB + Grafana for system health, tool usage, and service monitoring

When a connected client calls Sidekick tools, the work executes through Sidekick on the remote machine. The assistant or agent chooses the operation; Sidekick supplies and governs the capability.

The Agent Bridge is a separate system that can run tasks autonomously, but it's not integrated into the main AI's workflow. It's accessed via the Dashboard's Agent tab or direct API calls.

The Knowledge Base replaces the need for large markdown files. Instead of re-reading AGENTS.md or CONTEXT.md, the AI queries the database for specific information, saving tokens and improving accuracy.

**Current boundaries:**
- Sidekick Compute accepts only versioned, allowlisted model workloads; it is not arbitrary worker-side command execution.
- Evolve does not silently activate free-form code. Generated capabilities must pass validation and approval before trial or active exposure.
- The Agent Bridge acts only on submitted tasks, schedules, or watches and remains bounded by tool policy, approvals, iteration limits, and the same dispatcher used by other execution paths.
- The handler migration out of `src/tools-legacy.js` is still in progress, as disclosed above.

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

**Evolve Tool Warning:** `evolve` is critical-risk because it can approve and expose generated workflow tools. It does not treat free-text proposals as callable tools and generated capabilities must pass validation before trial activation. For shared or public-facing deployments, set `SIDEKICK_TOOL_POLICY=restricted` and require approval for `evolve` and high-risk generated tools.

## Dashboard & Agent Bridge

### Dashboard

Open `http://YOUR_REMOTE_IP:4098/` in a browser.

- **System** — uptime, CPU, memory, disk, LLM status, service indicators (MCP, Agent, Ollama)
- **Activity** — operational telemetry for what Sidekick did. The default view groups tool calls into sessions using real session/task identifiers when present, with deterministic time/source fallback grouping when they are not available. Raw calls remain available for audit/debugging with filters for source, status, tool, project, session/task, duration, errors, and text search.
- **Data** — practical KV browser for what Sidekick stores. Entries include namespace, project, source, size, type, timestamps, previews, totals, and a persistent inspector with structured JSON/plain-text/Markdown-safe rendering plus guarded edit/delete actions.
- **Memory** — durable knowledge for what Sidekick learned and should remember. Facts, decisions, preferences, procedures, observations, unresolved items, and session summaries are separated from operational/tool-call records so telemetry does not dominate the default memory experience.
- **Database** — schema browser, query editor, full-text search, migration management
- **Config** — environment variables (sensitive values redacted)
- **Agent** — submit tasks for the AI agent to execute autonomously
- **Approvals** — review, approve, or reject queued risky actions when approval mode is enabled
- **Tools** — browsable catalog of all 107 built-in tools plus approved generated tools, with search, category filtering, policy status, risk labels, and detailed argument info
- **Compute** — enrolled workers, providers, models, routing, jobs, artifacts, cancellation, retry, and lease recovery
- **Metrics** — embedded Grafana dashboards for system health, tool analytics, database performance, Docker containers, and Ollama metrics

### Metrics & Monitoring

Sidekick includes comprehensive metrics collection and visualization:

**Metrics Collection** (runs every minute via `sidekick-metrics.timer`):
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

Access Grafana directly at `http://YOUR_REMOTE_IP:3000/` using `sidekick` and the configured `SIDEKICK_GRAFANA_ADMIN_PASSWORD`.

### Knowledge Base

Sidekick includes a structured knowledge base for storing and retrieving project documentation:

- **34 packaged self-knowledge seed entries** across categories: best-practices, architecture, operations, protocols, development
- **Database-backed live content** that can include imported, custom, or migrated entries beyond the packaged seed
- **Full-text search** with semantic similarity
- **Manual import helper** for migrating CONTEXT.md into structured knowledge entries
- **Tool**: `knowledge` for search, get, list, add, update, delete

Example queries:
```bash
# Search for debugging best practices
knowledge action="search" query="debugging"

# List all architecture entries
knowledge action="list" category="architecture"

# Get specific entry
knowledge action="get" id=18
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

## Optional Agent Bootstrap with AGENTS.md

`AGENTS.md` is a portable bootstrap template for clients and agents that support persistent instructions. It is not required by the MCP protocol and is not the primary documentation store. Its purpose is to point an agent toward Sidekick's connection details, searchable knowledge, current tool registry, and project continuity data.

The template includes:
- Connection and endpoint guidance
- Knowledge-base query examples
- Tool catalog and registry query examples
- Basic operating and safety instructions

Automatic loading behavior depends on the client. Copy, import, or adapt [`AGENTS.md`](AGENTS.md) using the instruction mechanism supported by your chosen MCP client.

### Knowledge Base Categories

The knowledge base includes entries in these categories:
- **best-practices** — Interaction policies, debugging, tool selection, token efficiency
- **architecture** — Services, DB-first architecture, monitoring, tooling
- **operations** — Deployment, configuration, security, troubleshooting
- **protocols** — Context recall and other protocols

Query the knowledge base:
```bash
# List all categories
knowledge action="list"

# Search for specific topics
knowledge action="search" query="deployment"

# Get entries by category
knowledge action="list" category="best-practices"
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
- Accessible via `db_query` with `database="postgres"`

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
- Semantic search for `context` tool
- Embedding-based similarity search

### Metrics & Monitoring

**InfluxDB** (time-series database):
```bash
sudo systemctl start sidekick-influxdb
```
- Stores system metrics, tool usage, service status
- Metrics collected every minute via `sidekick-metrics.timer`

**Grafana** (visualization):
```bash
sudo systemctl start sidekick-grafana
```
- 6 pre-built dashboards
- Accessible at `http://YOUR_REMOTE_IP:3000/` using `sidekick` and the configured `SIDEKICK_GRAFANA_ADMIN_PASSWORD`
- Embedded in Dashboard's Metrics tab through the authenticated dashboard Grafana proxy

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
| `SIDEKICK_APPROVAL_MODE` | `off` | Optional dashboard approval mode: `off`, `risky`, or `strict` |
| `SIDEKICK_APPROVAL_TTL_SECONDS` | `3600` | Maximum age of a pending approval; approval payloads require `SIDEKICK_SECRET_KEY` |
| `SIDEKICK_APPROVAL_REQUIRED_TOOLS` | — | Comma-separated tools or risk selectors that always require approval |
| `SIDEKICK_APPROVAL_EXEMPT_TOOLS` | — | Comma-separated tools or risk selectors exempt from approval |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API URL (local fallback) |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | Default Ollama model |
| `GROQ_API_KEY` | — | Groq API key for cloud LLM (empty = use local Ollama) |
| `GROQ_MODEL` | `llama3-8b-8192` | Groq model name |
| `SIDEKICK_MAX_ITERATIONS` | `15` | Max agent loop iterations (safety limit) |
| `SIDEKICK_AUTO_MEMORY` | `1` | Enable bounded automatic memory summaries |
| `SIDEKICK_AUTO_MEMORY_MAX` | `500` | Max retained automatic memory entries |
| `SIDEKICK_EMBEDDINGS` | `1` | Enable semantic memory embeddings when Ollama/Qdrant are available |
| `SIDEKICK_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model for semantic memory recall |
| `SIDEKICK_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama URL used by memory embedding helpers |
| `SIDEKICK_AGENT_MODEL` | auto-detected, preferring `llama3.1` | Ollama model used by the Agent Bridge |
| `SIDEKICK_HEALTHCHECK_URL` | `https://github.com` | HTTPS endpoint used to verify outbound DNS and TLS connectivity |
| `SIDEKICK_POSTGRES_URL` | `postgresql://sidekick:sidekick@127.0.0.1:5432/sidekick` | PostgreSQL connection string |
| `SIDEKICK_REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string |
| `SIDEKICK_QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant vector DB URL |
| `SIDEKICK_INFLUX_URL` | `http://127.0.0.1:8086` | InfluxDB URL |
| `SIDEKICK_INFLUX_TOKEN` | — | InfluxDB authentication token; required for metrics and Grafana provisioning |
| `SIDEKICK_POSTGRES_PASSWORD` | — | Required when starting the bundled PostgreSQL container via `docker/docker-compose.yml` |
| `SIDEKICK_INFLUX_PASSWORD` | — | Required when starting the bundled InfluxDB container via `docker/docker-compose.yml` |
| `SIDEKICK_GRAFANA_ADMIN_PASSWORD` | — | Required when starting the bundled Grafana container via `docker/docker-compose.yml` |
| `SIDEKICK_INFLUX_ORG` | `sidekick` | InfluxDB organization |
| `SIDEKICK_INFLUX_BUCKET` | `sidekick` | InfluxDB bucket for metrics |

## Project Structure

```
├── src/
│   ├── tools.js            Compatibility re-export for the modular tool runtime
│   ├── tools/
│   │   ├── index.js        Public tool facade and compatibility exports
│   │   ├── registry.js     Descriptor registry for built-in tools
│   │   ├── dispatcher.js   Authoritative validation, policy, approval, execution, and audit path
│   │   ├── context.js      Request-scoped execution context
│   │   └── families/       Descriptor-owned extracted tool families
│   ├── tools-legacy.js     Remaining legacy handler implementations behind dispatcher adapters
│   ├── compute/            Worker, provider, model, job, routing, lease, and artifact system
│   ├── platform/           Shared execution, event, workflow, runner, workspace, and release kernel
│   ├── memory.js           Automatic memory capture and recall helpers
│   ├── index.js            MCP server, sessions, tool registration, and Compute HTTP routes
│   ├── dashboard.js        Dashboard web UI and management API
│   ├── agent.js            Agent Bridge task loop, streaming, delays, and watches
│   ├── redact.js           Sensitive data redaction
│   ├── db.js               SQLite database layer
│   ├── pg.js               PostgreSQL support
│   ├── redis.js            Redis client for caching
│   ├── qdrant.js           Qdrant vector DB client for semantic search
│   └── crypto-utils.js     Timing-safe comparison helpers
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
│   ├── 002_tool_registry.sql   Tool registry and knowledge base tables
│   ├── 003_structured_memory.sql Structured memory table
│   ├── 004_memory_lifecycle.sql Memory confirmation and decay support
│   ├── 005_sync_support.sql     Cross-machine memory sync metadata
│   └── 006_memory_deferred.sql  Memory state, confirmation, delete/expire fields
├── data/               Runtime data (on remote: logs, KV, conversations, metrics)
├── deploy.ps1          Deploy script (Windows)
├── deploy.sh           Deploy script (Linux/Mac)
├── .env.example        Environment variable template
└── AGENTS.md           Optional portable agent bootstrap template
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

**License:** GNU General Public License v3.0 only (`GPL-3.0-only`) · See [LICENSE](LICENSE) for details.

**Copyright:** © 2026 Geoffrey McClinsey.

**Contributing:** PRs welcome.

**Issues:** [Open one](https://github.com/geoffmcc/sidekick/issues) if you find a bug or have a feature request.
