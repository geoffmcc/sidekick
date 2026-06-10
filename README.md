# Sidekick

A remote VPS agent with MCP tools, live dashboard, and a local AI agent.

> **⚠️ Current Status:** Dashboard is temporarily broken due to a syntax error introduced during security hardening. The MCP server and agent are working normally. Dashboard will be fixed in the next development session. See CONTEXT.md for details.

## What is Sidekick?

Sidekick is not just a tool server. It is a **persistent remote AI collaborator** that lives on a VPS and works alongside you across every coding session. It can run commands on a remote machine, store and recall information across sessions, review your code, execute multi-step tasks autonomously, and serve as a second brain for your projects.

What sets Sidekick apart: it is **always on**, it **remembers things**, and it **reads your instructions every time you open a session** — so it knows how to help before you even ask.

> **Fun fact:** Sidekick has been actively helping develop itself — reviewing code, suggesting architecture improvements, and even helping write this README. It's not just a tool; it's a collaborator that's helping build its own future.

## How It Works: The AGENTS.md Loop

The secret sauce is a single file: `~/.config/opencode/AGENTS.md`.

Every time you open opencode, it automatically reads this file and loads whatever instructions are in it into the AI's context. Sidekick leverages this mechanism to make itself a persistent presence in your workflow:

1. **You open opencode** — it reads `AGENTS.md`
2. **Sidekick's tools and instructions are loaded** — the AI now knows about the VPS, the tools, and how to collaborate
3. **You work** — the AI can call sidekick tools, delegate tasks to the `@sidekick` subagent, or you can chat with the agent directly via the dashboard
4. **Session ends** — but anything stored in Sidekick's KV persists for next time

This is what makes Sidekick different from a plain MCP tool server. Without `AGENTS.md`, Sidekick is just a set of APIs. With it, Sidekick is a collaborator that is always present, always aware, and always ready.

## What You Can Achieve

| Capability | How | Why AGENTS.md Matters |
|---|---|---|
| **Remote code execution** | `sidekick_bash` runs commands on a persistent VPS | Instructions tell the AI when and how to use it |
| **Persistent memory across sessions** | `sidekick_store` / `sidekick_get` — KV storage that survives restarts | AI knows which keys to store and retrieve |
| **Autonomous multi-step tasks** | Agent bridge at `:4099` plans and executes until done | AI knows to delegate complex work to the agent |
| **Code review collaborator** | Ask sidekick to review diffs, catch issues, suggest improvements | Decision tree in AGENTS.md tells the AI *when* to ask |
| **GitHub integration** | Stored tokens let sidekick create repos, push code, manage PRs | AGENTS.md tells the AI where to find credentials |
| **Live monitoring dashboard** | Web UI at `:4098` — system health, activity, KV data, agent tasks | Always accessible, no config needed |
| **Web scraping from VPS** | `sidekick_web_fetch` bypasses local network restrictions | AI knows to use VPS for fetching when needed |
| **LLM on demand** | Cloud Groq for speed, local Ollama as fallback | AI knows which to use and when |

## Collaborative Workflows

Sidekick is designed to be involved throughout your project lifecycle, not just when you explicitly call it.

### When to Involve Sidekick

- **Code reviews** — Security-sensitive or multi-system changes → always review. Trivial changes (docs, comments, renames) → skip. Everything else → review if confidence < 95%.
- **Planning** — Involve sidekick during planning, not just before commit. It can catch architectural issues earlier.
- **Second opinions** — Weighing tradeoffs or design decisions? Get sidekick's perspective.
- **Issue identification** — Before testing or deployment, have sidekick analyze for potential problems.
- **Test coverage** — Ask sidekick to review test coverage, not just code correctness.
- **Documentation review** — Have sidekick review README, AGENTS.md, and other docs for completeness.

### How to Use Sidekick

- **`@sidekick` subagent** — Delegate complex multi-step tasks. The agent plans, calls tools, and iterates until the goal is met.
- **Dashboard chat** — Open `http://YOUR_VPS_IP:4098/` and use the Agent tab to submit tasks directly.
- **Direct MCP tools** — Use `sidekick_bash`, `sidekick_read`, `sidekick_write`, `sidekick_store`, `sidekick_get`, etc. from any MCP-compatible client.

### Best Practices

- **Provide context** — When asking for review, explain what the change does and why.
- **Be specific** — If you are unsure about something, tell sidekick what to focus on.
- **Early involvement** — The earlier sidekick is involved, the more valuable its input.
- **Rule of thumb** — If in doubt, ask sidekick. The overhead is minimal and the benefit is worth it.

## Persistent Memory

Sidekick's KV store is its long-term memory. Unlike conversation context, which disappears when the session ends, KV data persists indefinitely on the VPS.

**Example workflow:**

```
# Store a decision in one session
sidekick_store("project_status", "Migrated to new VPS, all services green")

# Retrieve it in a future session
sidekick_get("project_status")
# → "Migrated to new VPS, all services green"
```

The AGENTS.md file tells the AI *what* to store and *when* to retrieve it — turning Sidekick into a project memory that spans sessions, days, and even weeks.

## Setting Up AGENTS.md

> **This is the most important step.** Without this file, Sidekick is just a tool server. With it, Sidekick becomes a persistent collaborator that is present in every opencode session.

Create or edit `~/.config/opencode/AGENTS.md` and add the following (replace all placeholders with your values):

~~~markdown
# Sidekick VPS Configuration

## VPS Connection
- IP: YOUR_VPS_IP
- MCP Server: port 4097
- Dashboard: port 4098
- Agent Bridge: port 4099

## Credentials
- GitHub token stored in KV key: `github_token`
- Use `sidekick_get("github_token")` to retrieve it for GitHub API calls
- API usage:
  ```
  Authorization: token <TOKEN>
  Accept: application/vnd.github.v3+json
  ```

## Using Sidekick Proactively

Sidekick is not just for storage — use it as a collaborator throughout projects.

### When to Use Sidekick
- **Code reviews**: Ask sidekick to review changes before committing
  - Security-sensitive, multi-system, or infrastructure changes → Always review
  - Trivial changes (docs, comments, renames) → Skip
  - Everything else → Review if confidence < 95%
- **Planning**: Involve sidekick during planning phase, not just before commit
- **Second opinions**: When weighing tradeoffs or design decisions
- **Issue identification**: Before testing or deployment, analyze for potential problems
- **Test coverage**: Review test coverage, not just code correctness
- **Persistent memory**: Store project status, decisions, and outcomes in KV
- **Documentation review**: Review README, AGENTS.md, and other docs for completeness

### How to Use Sidekick
- `sidekick_bash` — Run analysis tasks, code reviews, suggestions on the VPS
- `sidekick_store` — Save important decisions and outcomes to KV
- `sidekick_get` — Retrieve stored context from previous sessions
- `sidekick_read` — Examine files on the VPS

### Best Practices
- **Provide context**: Explain what the change does and why
- **Be specific**: Tell sidekick what to focus on
- **Early involvement**: The earlier sidekick is involved, the more valuable its input

### Why It Matters
- Creates more conversation points and decision opportunities
- Provides structured review that catches issues early
- Makes the development process more interactive and engaging
- Builds a persistent record of project evolution

**Rule of thumb**: If in doubt, ask sidekick. The overhead is minimal and the benefit is worth it.
~~~

**opencode reads this file automatically on every session start.** No plugins, no hooks, no manual loading — just a markdown file in the right place.

## Recent Enhancements

### Project Labeling System
KV store now supports project-based organization. Store data with `project` parameter to group related keys, filter by project in the dashboard, and maintain better context across sessions.

### Sensitive Data Redaction
All tool outputs are automatically scanned for sensitive data (SSH keys, GitHub tokens, API keys, passwords, database URLs, etc.) and redacted before logging or display. Protects against accidental credential exposure.

### Enhanced Dashboard
- **Timestamps** with relative time display ("Created 2h ago", "Updated 5m ago")
- **Source badges** showing where data came from (mcp/agent/dashboard)
- **Expandable value previews** - click to see full content in a modal
- **Age filtering** - filter by today/this week/this month/all time
- **Failed command highlighting** - red background and border for errors
- **Sort by updated date** - newest entries first

### Comprehensive Testing Strategy
7-priority testing framework covering security, error handling, MCP protocol compliance, agent bridge, dashboard APIs, performance, and backward compatibility. Tests written and ready for execution.

## Architecture

```
┌─ Local Machine (source of truth) ─────────────────────┐
│  git push → github.com/geoffmcc/sidekick               │
│  ./deploy.ps1 → SSH into VPS, git pull, restart        │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ VPS (YOUR_VPS_IP) ────────────────────────────────┐
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

## Services

| Service | Port | Description |
|---------|------|-------------|
| **MCP Server** | 4097 | 8 tools: bash, read, write, list, store, get, web_fetch, llm |
| **Dashboard** | 4098 | Web UI: system health, activity log, KV data, agent |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (phi3:mini, CPU-only). Fallback when no `GROQ_API_KEY` |

## Quick Start

```powershell
# Clone (already done)
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick

# Copy env template and edit
copy .env.example .env
# Edit .env with your API key and settings

# Deploy to VPS (Windows)
.\deploy.ps1

# Or deploy (Linux/Mac)
./deploy.sh
```

## Daily Workflow

```powershell
# 1. Edit code in src/
# 2. Commit and push
git add -A
git commit -m "what you changed"
git push

# 3. Deploy to VPS (Windows)
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

## Configuration Changes

To change environment variables (ports, API keys, max iterations, etc.):

```powershell
# 1. Edit .env locally
notepad .env

# 2. Deploy (syncs .env to VPS and restarts services)
.\deploy.ps1
```

The deploy script automatically syncs `.env` to the VPS if it exists locally. No SSH required for config changes.

## MCP Tools

All tools are exposed via the MCP server at `http://YOUR_VPS_IP:4097/mcp`.

| Tool | Purpose |
|------|---------|
| `sidekick_bash` | Run shell commands |
| `sidekick_read` | Read files |
| `sidekick_write` | Write files |
| `sidekick_list` | List directories |
| `sidekick_store` | KV storage — store a value |
| `sidekick_get` | KV storage — retrieve a value |
| `sidekick_list_projects` | List all projects in KV store |
| `sidekick_get_by_project` | Get all keys for a specific project |
| `sidekick_web_fetch` | Fetch URLs from the VPS IP |
| `sidekick_llm` | Query the local Phi-3 model |

## Dashboard

Open `http://YOUR_VPS_IP:4098/` in a browser.

- **System** — uptime, CPU, memory, disk, LLM status, service indicators (MCP, Agent, Ollama)
- **Activity** — live tool call log with source icons (🤖 agent, 🔌 MCP, ❓ unknown)
- **Data** — KV store contents (auto-seeded on dashboard startup with 35 server reference keys: IP, services, security, software, deployment)
- **Config** — environment variables (sensitive values redacted)
- **Agent** — submit tasks for the AI agent to execute autonomously

## Agent Bridge

The agent at `:4099` takes a natural-language goal and runs an autonomous loop:

1. Sends goal + tool definitions to the LLM (Groq cloud or local Ollama)
2. LLM responds with a tool call decision
3. Bridge executes the tool via MCP
4. Feeds result back to LLM
5. Repeats until the task is complete

### API

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

## Security

| Layer | Measure |
|-------|---------|
| **MCP Server** | Bearer token auth + IP whitelist (`SIDEKICK_ALLOWED_IPS`) + dangerous command blocklist |
| **Dashboard** | HTTP Basic Auth (`SIDEKICK_DASHBOARD_USER`/`PASS`) + agent proxy via localhost-only bridge |
| **Agent Bridge** | Binds to `127.0.0.1` only, accessible exclusively through the dashboard proxy |
| **Sidekick user** | Sudo restricted to service management commands only (no wildcard `ALL`) |
| **Infrastructure** | SSH key-only, fail2ban, UFW, unattended-upgrades, `.env` file permissions locked to owner |

The dashboard auth and IP whitelist are disabled by default (empty env var = no restriction). Set them in `.env` before exposing to the internet.

## Files

```
├── src/
│   ├── tools.js        Shared tool handlers (extracted from index.js)
│   ├── index.js        MCP server (session-aware transport management)
│   ├── dashboard.js    Dashboard web UI (source tagging, Font Awesome icons)
│   └── agent.js        Agent bridge (LLM tool-use loop, direct tool calls)
├── data/               Runtime data (on VPS: logs, KV, conversations)
├── deploy.ps1          Deploy script — syncs and restarts services
├── .env.example        Environment variable template
├── AGENTS.md           opencode subagent config
├── CONTEXT.md          Project context and session notes
└── opencode.json       opencode MCP server config
```

## Environment

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
