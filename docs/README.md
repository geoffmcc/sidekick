# Sidekick Documentation

Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform intended to give opencode a persistent remote working environment. This documentation was rebuilt from the supplied `sidekick-main(1).zip` source tree and uses the current code as the source of truth.

The project currently exposes three Node.js services and 60 exported MCP tools.

## Documentation map

| File | Purpose |
|---|---|
| `overview.md` | What Sidekick is, how the pieces fit together, and common use cases. |
| `architecture.md` | Service boundaries, request flow, storage layout, sessions, and process model. |
| `installation.md` | Fresh install, deployment scripts, manual systemd setup, and opencode config. |
| `configuration.md` | Environment variables, ports, LLM settings, data directory, and auth settings. |
| `tools-reference.md` | Complete tool inventory generated from `src/tools.js`. |
| `tool-usage-guide.md` | Practical usage patterns and examples for important tool groups. |
| `dashboard.md` | Dashboard UI, API routes, webhooks, data editing, reset endpoints, and agent proxy. |
| `agent-bridge.md` | Autonomous task runner behavior, task history, streaming, delays, and watches. |
| `data-model.md` | Persistent JSON files, logs, KV schema, contexts, secrets, snapshots, queues, and transcripts. |
| `security.md` | Authentication, IP allowlists, redaction, command safety, dashboard protections, and risk notes. |
| `operations.md` | Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. |
| `development.md` | Source layout, testing, extension workflow, and implementation notes. |
| `api-reference.md` | HTTP endpoint reference for MCP, Dashboard, and Agent services. |

## Runtime services

| Service | Default port | Entry point | Purpose |
|---|---:|---|---|
| MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. |
| Dashboard | 4098 | `src/dashboard.js` | Browser UI and management API for logs, KV data, config, tools, and agent tasks. |
| Agent Bridge | 4099 | `src/agent.js` | Local API for autonomous task execution, task streaming, delayed jobs, and watches. |
| Ollama | 11434 | external | Optional local LLM provider. |

## Fast path

```bash
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick
cp .env.example .env
npm install
node src/index.js
```

For a persistent deployment, use the supplied deployment scripts or install the three systemd units under `systemd/`.
