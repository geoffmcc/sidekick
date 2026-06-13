# Configuration

Sidekick loads environment variables through `src/env.js` and normal Node.js `process.env`. The example file is `.env.example`.

## Environment variables

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `SIDEKICK_API_KEY` | `sk-sidekick-local-dev` | MCP, Agent | Bearer token for MCP authentication and agent calls. Change this for any real deployment. |
| `SIDEKICK_ALLOWED_IPS` | empty | MCP | Comma-separated IPv4 addresses or CIDR ranges allowed to reach the MCP server. Localhost is always allowed. |
| `SIDEKICK_PORT` | `4097` | MCP | MCP server port. |
| `SIDEKICK_DASHBOARD_PORT` | `4098` | Dashboard | Dashboard web/API port. |
| `SIDEKICK_AGENT_PORT` | `4099` | Dashboard, Agent | Agent Bridge API port. |
| `SIDEKICK_DASHBOARD_USER` | empty | Dashboard | Optional Basic Auth username. If empty with password empty, dashboard auth is disabled. |
| `SIDEKICK_DASHBOARD_PASS` | empty | Dashboard | Optional Basic Auth password. |
| `SIDEKICK_DASHBOARD_ALLOWED_IPS` | empty | Dashboard | Comma-separated IPv4 addresses or CIDR ranges allowed to reach the dashboard. |
| `SIDEKICK_DATA_DIR` | `data/` relative to repo | All services | Directory for persistent JSON/JSONL data. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Tools, Agent | Local Ollama API URL. |
| `GROQ_API_KEY` | empty | Tools, Agent | Enables Groq cloud LLM calls. |
| `GROQ_MODEL` | `llama-3.1-8b-instant` | Tools, Agent | Groq model name. |
| `SIDEKICK_DEFAULT_LLM` | tool-dependent | Tools | Default provider for `sidekick_llm` when provider is omitted. |
| `SIDEKICK_MAX_ITERATIONS` | `15` | Agent | Maximum agent planning/execution loop iterations per task. |
| `SIDEKICK_SECRET_KEY` | empty | `sidekick_secret` | Secret encryption key. Required for encrypted secret storage. |

## Ports

| Port | Service | Public exposure recommendation |
|---:|---|---|
| 4097 | MCP server | Expose only through VPN, SSH tunnel, reverse proxy, or IP allowlist. |
| 4098 | Dashboard | Keep private or protect with Basic Auth and network controls. |
| 4099 | Agent Bridge | Keep local/private; normally accessed through dashboard proxy. |
| 11434 | Ollama | Keep local/private. |

## Data directory

Set `SIDEKICK_DATA_DIR` to a stable path that is included in backups. In systemd deployment the example value is:

```bash
SIDEKICK_DATA_DIR=/home/sidekick/sidekick/data
```

Do not point multiple unrelated Sidekick deployments at the same data directory unless you intentionally want shared state.

## LLM provider behavior

`sidekick_llm` and agent reasoning can use Groq when `GROQ_API_KEY` is set, or local Ollama through `OLLAMA_URL`. Groq is generally faster and does not require a local model. Ollama keeps traffic local but requires local model availability and enough RAM/VRAM.

## Authentication defaults

The development default API key is intentionally easy to remember. It must be changed before exposing Sidekick outside localhost.

Dashboard authentication is off unless both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` are set. In a private LAN/VPN this may be acceptable; for any broader exposure, enable dashboard auth and put the service behind a reverse proxy or VPN.
