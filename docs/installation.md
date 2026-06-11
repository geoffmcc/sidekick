# Installation and Deployment

## Requirements

Sidekick is a Node.js project. The codebase expects:

- Node.js 18 or newer.
- npm for dependency installation.
- A Linux remote host for the intended deployment model.
- Git for deployment and repository management.
- systemd if using the service management model shown by the project.
- Optional: Ollama on `127.0.0.1:11434` for local LLM fallback.
- Optional: a Groq API key for faster cloud LLM calls.

## Local Setup

```bash
git clone <repository-url> sidekick
cd sidekick
npm install
cp .env.example .env
```

Edit `.env` before starting services. At minimum, set a non-default `SIDEKICK_API_KEY` if the MCP server is reachable by anything other than localhost.

## Starting Services Manually

The project defines three npm scripts:

```bash
npm run start      # starts src/index.js, the MCP server
npm run dashboard  # starts src/dashboard.js
npm run agent      # starts src/agent.js
```

The default ports are:

```text
MCP server:   4097
Dashboard:    4098
Agent bridge: 4099
```

The agent bridge binds to `127.0.0.1`, while the MCP and dashboard services listen on network interfaces according to their code and middleware configuration.

## Deployment Scripts

The repository includes:

- `deploy.sh` for Linux/macOS style deployment.
- `deploy.ps1` for Windows PowerShell deployment.

Review these scripts before running them in production. They are operational scripts and may assume a specific remote path, user, or systemd layout.

## opencode Integration

The repository contains `.opencode/agents/sidekick.md`, which defines a Sidekick subagent for opencode. The project README also describes using `AGENTS.md` to teach opencode about Sidekick.

A typical integration needs:

1. Sidekick services running on the remote host.
2. The MCP endpoint configured in the opencode environment.
3. The same API key configured in Sidekick and the client.
4. Agent instructions that tell opencode when to delegate work to Sidekick.

The MCP endpoint is:

```text
http://<host>:4097/mcp
```

The legacy SSE endpoint is:

```text
http://<host>:4097/sse
```

## Basic Verification

After starting the MCP server:

```bash
curl http://127.0.0.1:4097/health
```

After starting the dashboard:

```bash
curl http://127.0.0.1:4098/api/system
```

After starting the agent bridge:

```bash
curl http://127.0.0.1:4099/api/health
```

When dashboard authentication is configured, browser/API access requires HTTP Basic authentication except for the agent event-stream path.
