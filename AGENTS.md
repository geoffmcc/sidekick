# Sidekick VPS

A remote VPS agent system. Connect via the sidekick MCP server at `YOUR_VPS_IP:4097`.

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

## Services

- **MCP Server** (`:4097`) — 8 tools, called automatically when you use `sidekick_*` tools
- **Dashboard** (`:4098`) — web UI with System, Activity, Data, and Agent tabs
- **Agent Bridge** (`:4099`) — autonomous LLM agent that plans and executes multi-step tasks
- **Ollama** (`:11434`) — local Phi-3-mini fallback. Uses cloud Groq API when `GROQ_API_KEY` is set

## Usage

- **Direct tool use**: Just use any `sidekick_*` tool — the MCP server handles it automatically.
- **Subagent (`@sidekick`)**: Use for complex multi-step tasks. The agent will plan, call tools, and iterate until the goal is met.
- **Dashboard**: Open `http://YOUR_VPS_IP:4098/` in a browser for system monitoring and the agent chat interface.

## Deployment

After pushing to GitHub, SSH into the VPS and run:
```bash
cd /home/sidekick/mcp-sidekick
git pull
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

See `CONTEXT.md` for full project context.
