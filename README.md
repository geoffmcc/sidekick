# Sidekick

A persistent remote AI collaborator that remembers everything and reads your instructions every time you open [opencode](https://opencode.ai).

**How?** A single `AGENTS.md` file that opencode reads on every session start. No plugins, no hooks — just markdown.

> **Fun fact:** Sidekick has been actively helping develop itself — reviewing code, suggesting architecture improvements, and even helping write this README.

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

Every time you open opencode, it automatically reads `~/.config/opencode/AGENTS.md` and loads whatever instructions are in it into the AI's context. Sidekick leverages this mechanism to make itself a persistent presence in your workflow:

1. **You open opencode** — it reads `AGENTS.md`
2. **Sidekick's tools and instructions are loaded** — the AI now knows about the remote machine, the tools, and how to collaborate
3. **You work** — the AI can call sidekick tools, delegate tasks to the `@sidekick` subagent, or you can chat with the agent directly via the dashboard
4. **Session ends** — but anything stored in Sidekick's KV persists for next time

This is what makes Sidekick different from a plain MCP tool server. Without `AGENTS.md`, Sidekick is just a set of APIs. With it, Sidekick is a collaborator that is always present, always aware, and always ready.

## What You Can Achieve

| Capability | How | Why AGENTS.md Matters |
|---|---|---|
| **Remote code execution** | `sidekick_bash` runs commands on a persistent remote machine | Instructions tell the AI when and how to use it |
| **Persistent memory across sessions** | `sidekick_store` / `sidekick_get` — KV storage that survives restarts | AI knows which keys to store and retrieve |
| **Autonomous multi-step tasks** | Agent bridge at `:4099` plans and executes until done | AI knows to delegate complex work to the agent |
| **Code review collaborator** | Ask sidekick to review diffs, catch issues, suggest improvements | Decision tree in AGENTS.md tells the AI *when* to ask |
| **GitHub integration** | Stored tokens let sidekick create repos, push code, manage PRs | AGENTS.md tells the AI where to find credentials |
| **Live monitoring dashboard** | Web UI at `:4098` — system health, activity, KV data, agent tasks | Always accessible, no config needed |
| **Web scraping from remote** | `sidekick_web_fetch` bypasses local network restrictions | AI knows to use remote machine for fetching when needed |
| **LLM on demand** | Cloud Groq for speed, local Ollama as fallback | AI knows which to use and when |

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
| **MCP Server** | 4097 | 10 tools: bash, read, write, list, store, get, list_projects, get_by_project, web_fetch, llm |
| **Dashboard** | 4098 | Web UI: system health, activity log, KV data, agent tasks |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (phi3:mini). Fallback when no `GROQ_API_KEY` |

All tools are exposed via the MCP server at `http://YOUR_VPS_IP:4097/mcp`.

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

> **This is the most important step.** Without this file, Sidekick is just a tool server. With it, Sidekick becomes a persistent collaborator that is present in every opencode session.

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
- `@sidekick` subagent — Delegate complex multi-step tasks
~~~

**opencode reads this file automatically on every session start.** No plugins, no hooks, no manual loading — just a markdown file in the right place.

For the full AGENTS.md template with detailed usage guidelines, see [`AGENTS.md`](AGENTS.md) in this repo.

## Collaborative Workflows

Sidekick is designed to be involved throughout your project lifecycle, not just when you explicitly call it.

### When to Involve Sidekick

- **Code reviews** — Security-sensitive or multi-system changes → always review. Trivial changes (docs, comments, renames) → skip. Everything else → review if confidence < 95%.
- **Planning** — Involve sidekick during planning, not just before commit. It can catch architectural issues earlier.
- **Second opinions** — Weighing tradeoffs or design decisions? Get sidekick's perspective.
- **Issue identification** — Before testing or deployment, have sidekick analyze for potential problems.
- **Test coverage** — Ask sidekick to review test coverage, not just code correctness.

### Best Practices

- **Provide context** — When asking for review, explain what the change does and why.
- **Be specific** — If you are unsure about something, tell sidekick what to focus on.
- **Early involvement** — The earlier sidekick is involved, the more valuable its input.
- **Rule of thumb** — If in doubt, ask sidekick. The overhead is minimal and the benefit is worth it.

## Persistent Memory

Sidekick's KV store is its long-term memory. Unlike conversation context, which disappears when the session ends, KV data persists indefinitely.

**Example workflow:**

```
# Store a decision in one session
sidekick_store("project_status", "Migrated to new server, all services green")

# Retrieve it in a future session
sidekick_get("project_status")
# → "Migrated to new server, all services green"
```

The AGENTS.md file tells the AI *what* to store and *when* to retrieve it — turning Sidekick into a project memory that spans sessions, days, and even weeks.

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
4. Open `http://YOUR_VPS_IP:4098/` and say hello to your new collaborator

That's it. Sidekick is live.

---

**License:** MIT · See [LICENSE](LICENSE) for details.

**Contributing:** PRs welcome.

**Issues:** [Open one](https://github.com/geoffmcc/sidekick/issues) if you find a bug or have a feature request.
