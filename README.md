# Sidekick

A remote VPS agent with MCP tools, live dashboard, and a local AI agent — all running on a $20/month Ubuntu VPS.

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

## Services

| Service | Port | Description |
|---------|------|-------------|
| **MCP Server** | 4097 | 8 tools: bash, read, write, list, store, get, web_fetch, llm |
| **Dashboard** | 4098 | Web UI: system health, activity log, KV data, agent |
| **Agent Bridge** | 4099 | AI agent loop — LLM plans and calls MCP tools autonomously |
| **Ollama** | 11434 | Local LLM inference (phi3:mini, CPU-only) |

## Quick Start

```powershell
# Clone (already done)
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick

# Copy env template and edit
copy .env.example .env
# Edit .env with your API key and settings

# Deploy to VPS
.\deploy.ps1
```

## Daily Workflow

```powershell
# 1. Edit code in src/
# 2. Commit and push
git add -A
git commit -m "what you changed"
git push

# 3. Deploy to VPS
.\deploy.ps1
```

Or SSH directly to pull:
```bash
ssh sidekick@YOUR_VPS_IP
cd /home/sidekick/mcp-sidekick
git pull
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

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
| `sidekick_web_fetch` | Fetch URLs from the VPS IP |
| `sidekick_llm` | Query the local Phi-3 model |

## Dashboard

Open `http://YOUR_VPS_IP:4098/` in a browser.

- **System** — uptime, CPU, memory, disk, LLM status
- **Activity** — live tool call log (auto-refreshes every 10s)
- **Data** — KV store contents (auto-seeded on dashboard startup with 35 server reference keys: IP, services, security, software, deployment)
- **Agent** — submit tasks for the AI agent to execute autonomously
- *(Dashboard basic auth + hardened agent proxy in progress)*

## Agent Bridge

The agent at `:4099` takes a natural-language goal and runs an autonomous loop:

1. Sends goal + tool definitions to the local LLM
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

## Files

```
├── src/
│   ├── index.js        MCP server (all tools + logging)
│   ├── dashboard.js    Dashboard web UI
│   └── agent.js        Agent bridge (LLM tool-use loop)
├── data/               Runtime data (on VPS: logs, KV, conversations)
├── deploy.ps1          Deploy script — syncs and restarts services
├── .env.example        Environment variable template
├── AGENTS.md           opencode subagent config
└── opencode.json       opencode MCP server config
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDEKICK_API_KEY` | — | API key for MCP server auth |
| `SIDEKICK_PORT` | 4097 | MCP server port |
| `SIDEKICK_DASHBOARD_PORT` | 4098 | Dashboard port |
| `SIDEKICK_AGENT_PORT` | 4099 | Agent bridge port |
| `SIDEKICK_DASHBOARD_USER` | — | Dashboard basic auth username (empty = disabled) |
| `SIDEKICK_DASHBOARD_PASS` | — | Dashboard basic auth password (empty = disabled) |
| `SIDEKICK_DATA_DIR` | `./data` | Data directory for logs, KV, conversations |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API URL |
