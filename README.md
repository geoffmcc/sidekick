# Sidekick

[![M8ven Live Monitored](https://m8ven.ai/badge/mcp/geoffmcc-sidekick-1j2km0)](https://m8ven.ai/mcp/geoffmcc-sidekick-1j2km0)

**Autonomous Agent Platform**

Sidekick is a self-hosted platform that gives AI assistants and agents durable infrastructure: a remote machine they can operate, persistent project memory and knowledge that survive any single session, a governed and dynamically discoverable MCP tool catalog, an autonomous task runner, and distributed model compute. The connected assistant or agent is replaceable — you can switch clients, models, or vendors — while the projects, memory, tools, policy, and history stay on your machine, under your control.

See the [privacy policy](docs/privacy.md). A running HTTP instance also exposes it at `/privacy` for directory and integration review.

**Why use it?** Because most AI work loses everything between sessions. With Sidekick, one session's decisions, handoffs, and stored facts are retrievable by the next session — or by a completely different agent. Typical uses that the current implementation supports:

- keeping project continuity across AI sessions and across different agents/models;
- software development and project work on a persistent remote machine (shell, files, git, GitHub API, CI inspection, databases);
- bounded autonomous tasks through the Agent Bridge (submit a goal, get evidence-backed execution);
- self-hosted AI infrastructure and homelab/system administration (services, processes, networking, monitoring, incident capture);
- scheduled and event-driven automation (cron, one-shot delays, watches, runbooks);
- routing local/distributed model workloads (chat, generation, embeddings) across enrolled compute workers.

**How?** Connect a compatible MCP client to Sidekick, then optionally adapt the included `AGENTS.md` template so the client knows how to use its persistent tools and knowledge.

For a local installation, configure the client to launch the packaged runtime:

```json
{
  "mcpServers": {
    "sidekick": {
      "command": "npx",
      "args": ["-y", "github:geoffmcc/sidekick"]
    }
  }
}
```

See [`docs/local-deployment.md`](docs/local-deployment.md) for persistent
state locations, CLI commands, client notes, security, Compute, capability
packs, and troubleshooting. Dedicated HTTP/SSE deployment remains documented
in [`docs/installation.md`](docs/installation.md).

> **Note:** This project was developed using its own remote execution tools — the AI assistant used Sidekick's infrastructure to help build and test the very system it runs on.

## Refactor Status and Compatibility Disclosure

> **Full disclosure:** Sidekick's tool runtime finished its modular handler migration. The descriptor registry, centralized dispatcher, request-scoped context, schema validation, source-aware policy, approval enforcement, redaction, and audit logging are the authoritative production execution path, and every tool handler is now owned by a descriptor family under `src/tools/families/`, the `data-utilities` module, or the Compute subsystem — `src/tools-legacy.js` owns **zero** production tool handlers. What remains in `src/tools-legacy.js` (~1,500 lines) is the tool policy/approval/audit engine, the legacy `TOOL_DEFS` ordering anchors, compute pass-through wiring, and compatibility re-exports kept for existing consumers; relocating those is routine follow-up, not a risk boundary. The broader platform convergence campaign (canonical project identity, event consumption, artifact custody, connector integration, and related slices) is still in progress — see [`docs/platform-roadmap.md`](docs/platform-roadmap.md) for what remains and [`docs/tool-architecture.md`](docs/tool-architecture.md) for the tool-runtime boundary.

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

Sidekick exposes its tool catalog through the Model Context Protocol and supports two deployment topologies:

```text
Sidekick
├── Local deployment
└── Dedicated deployment
```

MCP clients can launch the full runtime locally through the packaged `sidekick`
executable and stdio, without a dedicated Sidekick server. Dedicated server
installations continue to expose Streamable
HTTP and legacy SSE with their existing authentication and service layout.
Both topologies use the same governed registry, dispatcher, persistence,
memory, workflows, capability packs, and Compute paths. The included
`AGENTS.md` file is an optional, portable bootstrap template for clients that
support persistent project or agent instructions.

1. **An MCP client connects** — it authenticates to the Sidekick MCP server on port 4097.
2. **Sidekick publishes the available tool catalog** — policy, risk, and approval rules are applied for the request source.
3. **The assistant or agent calls tools** — it can operate the remote machine, query knowledge, store durable context, or submit work to the Agent Bridge.
4. **State persists** — approved memories, project data, workflows, logs, and knowledge remain available after the client session ends.

Sidekick provides the persistent infrastructure; the connected assistant or agent decides when and how to use it. Exact prompting and automatic instruction-file loading depend on the MCP client.

Capability packs extend Sidekick with focused areas of competence without requiring every future feature to be part of Core. Packs can contribute modules, tools, workflows, knowledge, and configuration, and can be bundled with Sidekick or supplied by compatible third parties.

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

### Project Continuity Across Sessions and Agents

The core continuity workflow: one agent or session does the work and leaves a durable handoff; a later session — possibly a different client or model entirely — retrieves it and continues without rebuilding context by hand.

1. **Session A** works on a project, storing durable facts with `store`, tracking decisions with `context`, and optionally opening an explicit envelope with `session action="begin"`.
2. **Before stopping**, it leaves a handoff: `resume action="set" project="myproject"` with the summary, next step, and branch (or a richer `handoff action="create"` record).
3. **Session B** — hours or weeks later, on any compatible MCP client — starts with `resume action="check" project="myproject"`, recalls context with `project name="myproject"` or `context action="recall"`, and continues the work.

Retrieval is explicit: the connected agent has to ask for the handoff (the `AGENTS.md` template teaches it to check at session start). Sidekick stores and serves the state; it does not inject it automatically into a new client session.

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
- Tool usage analytics (call counts, success rates, average, p50, p95, p99, min, and max duration)
- Dispatcher phase latency (registry, resolution, validation, policy, approval, and handler timing) in redacted tool activity records
- Service status monitoring
- Database performance metrics
- Docker container stats
- Ollama LLM metrics

### 🔄 Evidence-Driven Workflow Learning
Sidekick can learn repeated successful workflows from redacted tool telemetry. `teach` stores reusable procedures composed from existing tools. `evolve` mines repeated bounded workflows, infers safe parameters, validates the procedure, and only after explicit approval exposes trial or active generated capabilities as namespaced MCP tools such as `generated_<name>`.

### 🤖 True Autonomous Operation
The Agent Bridge runs independently from your main AI session. Submit a complex task via the dashboard, and Sidekick will plan, execute, and iterate until it's done—without you babysitting each step.

### 🖥️ Distributed Compute
Sidekick Compute enrolls authenticated worker agents and routes allowlisted `chat`, `generate`, and `embeddings` jobs (including certified OpenVINO NPU/CPU text-embedding jobs) across registered workers, providers, and models. It includes scoped worker credentials, job leases, progress, cancellation, retry/recovery, artifacts, health reporting, routing rules, and dashboard controls. It is intentionally not an arbitrary remote shell or a general-purpose GPU batch system.

### 🔒 Security-First Design
Every tool output is automatically scanned and redacted for sensitive data (API keys, tokens, passwords). The dashboard has rate limiting, CSRF protection, and audit logging. The agent bridge is isolated and only accessible through the dashboard.

### 🛠️ 112 Built-In Specialized Tools
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
| **LLM on demand** | Compute routes allowlisted inference across registered providers and models | AI can request inference without selecting credentials or endpoints |
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

*The Agent Bridge sends inference through Compute. Provider bootstrap can register Ollama, Groq, and OpenAI-compatible providers, but private conversations remain on eligible local/trusted providers by default and fail closed rather than silently reaching the cloud. Sidekick Compute workers are separate enrolled processes that connect to scoped `/compute/worker/*` routes on the MCP service; they are not additional always-on services inside the three-process core.*

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
- **Groq/OpenAI-compatible** (cloud) — Available when configured and permitted by Compute placement policy

## Services & Tools

| Service | Port | Description |
|---------|------|-------------|
| **MCP Server** | 4097 | Dynamically discovered built-in, module, pack, and approved generated tools across 20 categories |
| **Dashboard** | 4098 | Web UI for system health, activity, data, memory, approvals, tools, Compute, agent tasks, and metrics |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (qwen2.5-coder:7b, llama3.1:8b, nomic-embed-text) |
| **Redis** | 6379 | Session-scoped caching with TTL |
| **Qdrant** | 6333 | Vector database for semantic search |
| **InfluxDB** | 8086 | Time-series metrics (system health, tool usage, service status) |
| **Grafana** | 3000 | Metrics visualization with 6 pre-built dashboards |

All tools are exposed via the MCP server at `http://YOUR_REMOTE_IP:4097/mcp`.

### Tool Categories

The tool catalog is organized into 20 categories. Core, module, capability-pack, and approved generated tools share one live registry; use `tools action="overview"` or the database catalog for the current count and enabled state. Installing a capability pack adds its tools to the same registry — the Developer pack adds `dev_repo_profile`, `dev_change_summary` and `dev_verify`:
- **Core** — bash, tools, read, write, list, search, web_fetch, llm, respond
- **Storage** — store, get, delete, resume, list_projects, get_by_project, redis
- **Database** — db_schema, db_query, db_stats, db_backup, db_restore, db_export, log_query, db_search, db_migrate, db_diff, analytics
- **Git & GitHub** — git, github, ci_status
- **Services** — process, service, module, capability, workflow
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

### Capability Packs

Sidekick Core does not have to absorb every future area of functionality. A
**capability pack** is an installable *area of competence* — modules, workflow
definitions, knowledge assets and configuration — installed, enabled,
configured, upgraded and uninstalled through one lifecycle:

```
capability action="available"                    # bundled packs you can install
capability action="install"   name="developer"
capability action="enable"    name="developer"
capability action="health"    name="developer"
workflow   action="run" name="developer/repository-recon" inputs={ "path": "/srv/repo" }
```

or Dashboard → **Capabilities**.

The same lifecycle supports both bundled and compatible third-party packs. A
third-party pack is installed from an approved server-local package path and is
inspected before installation; its manifest identifies the publisher,
provenance, version, contributed components and required permissions. Once
installed, its modules and other contributions use the same registry,
dispatcher, policy, approval, redaction and audit boundaries as built-in and
bundled functionality. Installation and enablement execute package code inside
the Sidekick process, so only install packs you trust and use the restricted
tool policy plus approval requirements for shared or public-facing deployments.

For the package format, manifest requirements, inspection flow and lifecycle
commands, see [`docs/capability-packs.md`](docs/capability-packs.md). To build
your own compatible pack, follow the [third-party capability-pack authoring
guide](docs/third-party-capability-packs.md).

Packs compose the subsystems Sidekick already has: pack tools are normal
descriptors in the one registry with the one dispatcher, pack modules install
through the module lifecycle, pack workflows register in the workflow
definition registry, and pack knowledge lands in the ordinary knowledge base.
There is no second plugin runtime and no remote marketplace.

Six first-party packs ship bundled: the **Developer / Software Engineering**
pack, the **Jellyfin** pack, the **Proxmox VE** pack, the **Container
Operations (Docker / Podman)** pack, the **Security Research** pack, and the
**Governed Browser Automation** pack. They provide structured repository work,
named-profile media operations, guarded infrastructure, independent container
operations, governed research, and task-level browser workflows respectively.
See
[`docs/capability-packs.md`](docs/capability-packs.md),
[`docs/developer-pack.md`](docs/developer-pack.md),
[`docs/jellyfin-pack.md`](docs/jellyfin-pack.md),
[`docs/proxmox-pack.md`](docs/proxmox-pack.md) and
[`docs/container-operations-pack.md`](docs/container-operations-pack.md),
 [`docs/security-research-pack.md`](docs/security-research-pack.md), plus
 [`docs/browser-automation.md`](docs/browser-automation.md).

> Installing or enabling a pack activates executable module code inside the
> Sidekick process. Inspection never executes package code, and every installed
> package is integrity-verified before it loads — but there is no sandbox.
> Treat installing a third-party pack as equivalent to deploying code.

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

- **Sidekick** = The self-hosted agent platform: a governed live MCP catalog (core, module, pack, and approved generated tools) + persistent memory + knowledge base + Dashboard + Agent Bridge + metrics + Sidekick Compute + capability packs
- **The assistant or agent** = Any compatible MCP client, coding assistant, or automation agent that uses Sidekick's platform
- **Tool runtime** = The descriptor registry and dispatcher that validate, authorize, approve, execute, redact, and audit tool calls across MCP, dashboard, agent, scheduler, and generated-tool paths
- **Agent Bridge** = Sidekick's autonomous task runner, accessed through the Dashboard and API
- **Knowledge Base** = Structured documentation stored in SQLite, searchable via `knowledge`
- **Sidekick Compute** = The allowlisted worker/provider/model/job system for distributed inference workloads
- **Module** = A runtime implementation contributed to Sidekick: code that builds tool descriptors and reports health, managed through a full install/configure/enable/upgrade/uninstall lifecycle
- **Workflow** = A durable, reusable multi-step execution defined as data and run through the tool dispatcher, with checkpoints, project identity, cancellation and approval continuation
- **Capability Pack** = An installable *area of competence* composed from modules, workflows, knowledge and configuration. Six first-party packs ship bundled; use live capability discovery for exact installed state. See `docs/capability-packs.md`.
- **Connector** = A managed relationship with an external service or system. GitHub is the current governed provider; broader connector health, mutation, dashboard coverage, and additional providers remain future work.
- **Metrics System** = InfluxDB + Grafana for system health, tool usage, and service monitoring

When a connected client calls Sidekick tools, the work executes through Sidekick on the remote machine. The assistant or agent chooses the operation; Sidekick supplies and governs the capability.

The Agent Bridge is a separate system that can run tasks autonomously, but it's not integrated into the main AI's workflow. It's accessed via the Dashboard's Agent tab or direct API calls.

The Knowledge Base replaces the need for large markdown files. Instead of re-reading AGENTS.md or CONTEXT.md, the AI queries the database for specific information, saving tokens and improving accuracy.

**Current boundaries:**
- Sidekick Compute accepts only versioned, allowlisted model workloads; it is not arbitrary worker-side command execution.
- Evolve does not silently activate free-form code. Generated capabilities must pass validation and approval before trial or active exposure.
- The Agent Bridge acts only on submitted tasks, schedules, or watches and remains bounded by tool policy, approvals, iteration limits, and the same dispatcher used by other execution paths.
- The module system's full lifecycle is implemented for first-party AND third-party modules: safe package inspection, a managed module store, verified entry-point loading with whole-package integrity, install/configure/enable/disable/upgrade/uninstall, and a derived health model. **Installed module code is trusted executable code running in-process with Sidekick's privileges — there is no sandbox and none is claimed.** The controls are integrity, provenance and lifecycle, not isolation. Treat installing a third-party pack as equivalent to deploying code.
- Capability packs compose existing subsystems; they are not a second plugin runtime, dispatcher or workflow engine. There is no remote marketplace: packs are installed from the bundled release copy or from an approved server-local path.
- Handler extraction out of `src/tools-legacy.js` is complete (zero production handlers remain there); the remaining platform convergence work is tracked in `docs/platform-roadmap.md`.

## Security

| Layer | Measure |
|-------|---------|
| **MCP Server** | Bearer token auth + IP whitelist (`SIDEKICK_ALLOWED_IPS`) + dangerous command blocklist + configurable tool policy |
| **Dashboard** | Local identity sessions + optional Basic Auth compatibility + rate limiting + CSRF protection + audit logging + tool policy visibility |
| **Agent Bridge** | Binds to `127.0.0.1` only, accessible exclusively through the dashboard proxy |
| **Sidekick user** | Sudo restricted to service management commands only (no wildcard `ALL`) |
| **Infrastructure** | SSH key-only, fail2ban, UFW, unattended-upgrades, `.env` file permissions locked to owner |
| **Data Redaction** | All tool outputs automatically redact SSH keys, GitHub tokens, API keys, passwords, database URLs, etc. |

Fresh `.env.example` configurations allow only loopback clients by default and
use restricted tools with strict approval. Add explicit trusted client
subnets to `SIDEKICK_ALLOWED_IPS` and `SIDEKICK_DASHBOARD_ALLOWED_IPS` before
remote exposure. Dashboard identity bootstrap/login protects the UI and API;
`SIDEKICK_DASHBOARD_USER`/`SIDEKICK_DASHBOARD_PASS` are optional legacy Basic
Auth compatibility credentials. Existing installations keep their explicit
environment values, including intentionally broad allowlists or `open` policy.

**Capability Tool Warning:** `capability` is critical-risk because installing or enabling a capability pack activates executable module code inside the Sidekick process. Inspection is safe and never executes package code, but installation and enablement are deployments. Packages are refused for path traversal, symlinks, escaping entry points, descriptor collisions, built-in tool shadowing and packaged secrets, and every installed package is integrity-verified before it loads — but none of that is a sandbox. For shared or public-facing deployments, set `SIDEKICK_TOOL_POLICY=restricted` and require approval for `capability`.

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
- **Tools** — browsable catalog of built-in tools plus module-, pack- and approved generated tools, with search, category filtering, policy status, risk labels, and detailed argument info
- **Capabilities** — installed capability packs with version, publisher, provenance (first-party/third-party, bundled), state, health, integrity and configuration validity, plus contributed modules, tools, workflows and knowledge; available bundled packs; and inspection/installation from an approved server-local path. Actions: Details, Health Check, Enable, Disable, Upgrade, Uninstall. Every mutation dispatches the governed `capability` tool server-side.
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

- **35 packaged self-knowledge seed entries** across categories: best-practices, architecture, operations, protocols, development
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

1. Sends goal + tool definitions to Compute for provider/model selection
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
./deploy.sh -IP YOUR_REMOTE_IP
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
| `-IP` | Remote machine address (for example, `YOUR_REMOTE_IP`) |
| `-InitialUser` | Initial SSH user for bootstrap (e.g., ubuntu, admin, root) |

**First deploy:** The script prompts for the initial SSH user if not provided, then prompts for their password once. It then bootstraps the VM (creates sidekick user, installs Node.js, configures sudoers, installs services, installs SSH key, and opens firewall ports). After that, deploys are fully automated with no password required.

**Automation/CI:** Specify the initial user with `-InitialUser` to skip the interactive prompt:
```powershell
# Windows
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -InitialUser "ubuntu"

# Linux/Mac
./deploy.sh -IP YOUR_REMOTE_IP -InitialUser ubuntu
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
| `SIDEKICK_SECRET_DIR` | `/etc/sidekick/secrets` | Directory containing protected secret files; raw secret environment values are rejected |
| `SIDEKICK_ALLOWED_IPS` | — | Comma-separated IP whitelist for MCP server (empty = allow all) |
| `SIDEKICK_PORT` | 4097 | MCP server port |
| `SIDEKICK_DASHBOARD_PORT` | 4098 | Dashboard port |
| `SIDEKICK_AGENT_PORT` | 4099 | Agent bridge port |
| `SIDEKICK_DASHBOARD_USER` | — | Dashboard basic auth username (empty = disabled) |
| `sidekick_dashboard_pass` | — | Secret file for dashboard basic auth password (missing = disabled) |
| `SIDEKICK_DATA_DIR` | `./data` | Data directory for logs, KV, conversations |
| `SIDEKICK_TOOL_POLICY` | `restricted` | Tool policy mode: `open` or `restricted` |
| `SIDEKICK_BLOCKED_TOOLS` | — | Comma-separated global blocklist of tool names or risk selectors |
| `SIDEKICK_ALLOWED_TOOLS` | — | Comma-separated global allowlist of tool names or risk selectors |
| `SIDEKICK_AGENT_TOOL_POLICY` | — | Source-specific tool policy override for the Agent Bridge |
| `SIDEKICK_MCP_TOOL_POLICY` | — | Source-specific tool policy override for MCP clients |
| `SIDEKICK_DASHBOARD_TOOL_POLICY` | — | Source-specific tool policy override for dashboard-originated calls |
| `SIDEKICK_APPROVAL_MODE` | `strict` | Dashboard approval mode: `off`, `risky`, or `strict` |
| `SIDEKICK_APPROVAL_TTL_SECONDS` | `3600` | Maximum age of a pending approval; approval payloads require `SIDEKICK_SECRET_KEY` |
| `SIDEKICK_APPROVAL_REQUIRED_TOOLS` | — | Comma-separated tools or risk selectors that always require approval |
| `SIDEKICK_APPROVAL_EXEMPT_TOOLS` | — | Comma-separated tools or risk selectors exempt from approval |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API URL for the local Compute provider |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | Default Ollama model |
| `groq_api_key` | — | Optional protected Groq credential file; Compute registers the provider when present |
| `GROQ_MODEL` | `llama-3.1-8b-instant` | Groq model name |
| `openai_api_key` | — | Optional protected OpenAI-compatible credential file |
| `OPENAI_BASE_URL` | — | Optional OpenAI-compatible provider endpoint |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI-compatible chat model |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI-compatible embedding model |
| `SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP` | `0` | Disable environment provider registration |
| `SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP` | `0` | Disable only the default Ollama provider registration |
| `SIDEKICK_MAX_ITERATIONS` | `15` | Max agent loop iterations (safety limit) |
| `SIDEKICK_AUTO_MEMORY` | `1` | Enable bounded automatic memory summaries |
| `SIDEKICK_AUTO_MEMORY_MAX` | `500` | Max retained automatic memory entries |
| `SIDEKICK_EMBEDDINGS` | `1` | Enable semantic memory embeddings when Ollama/Qdrant are available |
| `SIDEKICK_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model for semantic memory recall |
| `SIDEKICK_AGENT_MODEL` | — | Optional Agent Bridge/Compute chat-model override; otherwise `OLLAMA_MODEL` is used |
| `SIDEKICK_HEALTHCHECK_URL` | `https://github.com` | HTTPS endpoint used to verify outbound DNS and TLS connectivity |
| `SIDEKICK_POSTGRES_URL` | — | Optional PostgreSQL connection string; overrides the discrete connection fields |
| `SIDEKICK_REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string |
| `SIDEKICK_QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant vector DB URL |
| `SIDEKICK_INFLUX_URL` | `http://127.0.0.1:8086` | InfluxDB URL |
| `sidekick_influx_token` | — | Protected InfluxDB token file; required for metrics and Grafana provisioning |
| `sidekick_postgres_password` | — | Protected PostgreSQL password file for bundled Compose service |
| `sidekick_influx_password` | — | Protected InfluxDB password file for bundled Compose service |
| `sidekick_grafana_admin_password` | — | Protected Grafana password file for bundled Compose service |
| `SIDEKICK_GRAFANA_PORT` | `3000` | Local Grafana port used by dashboard health checks and proxying |
| `SIDEKICK_GRAFANA_ROOT_URL` | `http://localhost:4098/grafana/` | Compose-only Grafana public root URL |
| `SIDEKICK_ALLOW_PRIVATE_FETCH` | `false` | Allow web fetches to loopback/private destinations; metadata and link-local remain blocked |
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
│   │   ├── dispatch-seam.js Dependency-free nested tool dispatch seam
│   │   └── families/       Descriptor-owned tool families (all built-in handlers)
│   ├── tools-legacy.js     Tool policy/approval/audit engine, TOOL_DEFS ordering anchors,
│   │                       and compatibility re-exports (owns zero tool handlers)
│   ├── modules/            Module lifecycle: manifest, discovery, packaging, managed store,
│   │                       verified entry loading, install/configure/enable/upgrade/uninstall,
│   │                       permissions, migrations, health (bundled: data-utilities)
│   ├── packs/              Capability-pack lifecycle: manifest, packaging, managed store,
│   │                       ownership, install/enable/upgrade/uninstall, derived health
│   ├── workflows/          Workflow definition registry, reference contract, and the runner
│   │                       over the kernel's execution primitives
│   ├── approvals/          Durable task-originated approval continuation (ADR stack)
│   ├── brain/              Feature-flagged bounded planner over the Agent Bridge (default off)
│   ├── compute/            Worker, provider, model, job, routing, lease, and artifact system
│   ├── platform/           Platform kernel: executions, events, artifacts, projects,
│   │                       workspaces, connectors, and research record foundations
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
├── packs/
│   ├── browser-automation/  Bundled Governed Browser Automation capability pack
│   ├── developer/           Bundled Developer / Software Engineering capability pack
│   ├── jellyfin/            Bundled Jellyfin capability pack
│   ├── container-operations/ Bundled Docker / Podman Container Operations pack
│   ├── proxmox/             Bundled Proxmox VE capability pack
│   └── security-research/   Bundled Security Research capability pack
├── scripts/
│   ├── bootstrap.sh    VM bootstrap script (creates user, installs Node.js, etc.)
│   ├── setup-tools.sh  Server tooling setup (Docker, databases, media tools, etc.)
│   ├── collect-metrics.js  Metrics collection script (runs via cron)
│   └── seed-knowledge.js   Seed the knowledge base on fresh deployments
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
├── migrations/             35 ordered SQLite migrations: core schema, tool registry,
│                           structured memory, Black Box, platform kernel, Compute,
│                           approvals, modules, projects, events, connectors, research records
├── packaging/              Compute worker OS-service installers (systemd, launchd, winsw)
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
3. Run `.\deploy.ps1 -IP "YOUR_REMOTE_IP"` (Windows) or `./deploy.sh -IP YOUR_REMOTE_IP` (Linux/Mac)
4. Enter the sidekick password when prompted (first deploy only)
5. Open `http://YOUR_REMOTE_IP:4098/` and explore your new autonomous agent platform

That's it. Sidekick is live.

---

**License:** GNU General Public License v3.0 only (`GPL-3.0-only`) · See [LICENSE](LICENSE) for details.

**Copyright:** © 2026 Geoffrey McClinsey.

**Contributing:** PRs welcome.

**Issues:** [Open one](https://github.com/geoffmcc/sidekick/issues) if you find a bug or have a feature request.
