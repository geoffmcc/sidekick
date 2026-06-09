# Sidekick VPS

A remote VPS agent system. Connect via the sidekick MCP server at `149.28.229.13:4097`.

## MCP Tools (8)

| Tool | When to use |
|------|-------------|
| `sidekick_bash` | Run any shell command on the VPS |
| `sidekick_read` | Read a file from the VPS filesystem |
| `sidekick_write` | Write or edit a file on the VPS |
| `sidekick_list` | List files and directories on the VPS |
| `sidekick_store` | Store a value persistently in KV storage |
| `sidekick_get` | Retrieve a stored value from KV storage |
| `sidekick_web_fetch` | Fetch a URL from the VPS IP (bypasses local IP restrictions) |
| `sidekick_llm` | Query the LLM (Groq cloud or local Phi-3-mini) |

All tool calls are logged with source tags:
- 🤖 **agent** - Calls from the autonomous agent bridge
- 🔌 **mcp** - Calls from external MCP clients (opencode, etc.)
- ❓ **unknown** - Legacy calls without source tag

## Services

- **MCP Server** (`:4097`) — 8 tools, session-aware transport (new McpServer+Transport per session)
- **Dashboard** (`:4098`) — web UI with System, Activity, Data, Config, and Agent tabs, Font Awesome icons
- **Agent Bridge** (`:4099`) — autonomous LLM agent that calls tools directly (bypasses MCP HTTP)
- **Ollama** (`:11434`) — local Phi-3-mini fallback. Uses cloud Groq API when `GROQ_API_KEY` is set

## Usage

- **Direct tool use**: Just use any `sidekick_*` tool — the MCP server handles it automatically.
- **Subagent (`@sidekick`)**: Use for complex multi-step tasks. The agent will plan, call tools, and iterate until the goal is met.
- **Dashboard**: Open `http://149.28.229.13:4098/` in a browser (auth: geoffrey) for system monitoring and the agent chat interface.

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
ssh sidekick@149.28.229.13
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
