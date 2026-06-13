# Architecture

Sidekick is a three-process Node.js application with a shared data directory.

```text
opencode / MCP client
        |
        | Bearer token
        v
MCP Server :4097  ---- loads/registers tools ----> src/tools.js
        |
        | JSON files under SIDEKICK_DATA_DIR
        v
Persistent data directory

Browser
        |
        v
Dashboard :4098 ---- proxy ----> Agent Bridge :4099

Agent Bridge :4099 ---- calls ----> src/tools.js
```

## Service boundaries

### MCP server: `src/index.js`

The MCP server creates an `McpServer` from `@modelcontextprotocol/sdk`, registers the Sidekick tool definitions, and serves them over:

- `POST /mcp`, `GET /mcp`, and `DELETE /mcp` for Streamable HTTP;
- `GET /sse` and `POST /messages` for legacy SSE clients;
- `GET /health` for diagnostics.

The server requires `Authorization: Bearer <SIDEKICK_API_KEY>` or `?api_key=<key>` for MCP routes. It can also enforce `SIDEKICK_ALLOWED_IPS`.

### Tool implementation: `src/tools.js`

The tool module owns most application behavior. It loads configuration, ensures the data directory exists, implements tool handlers, redacts sensitive output, logs tool calls, and persists JSON state files.

Important exported values include:

- `TOOLS`: map of tool name to handler function.
- `TOOL_DEFS`: dashboard-facing catalog of tool names, descriptions, and argument summaries.
- `callTool(name, args)`: central dispatcher used by the agent and wrapper tools.
- `logToolCall(...)`: appends JSONL audit-style tool activity to `log.jsonl`.
- `setSource(source)`: records whether a call came from MCP, dashboard, agent, or another path.

### Dashboard: `src/dashboard.js`

The dashboard serves a browser UI and JSON API. It reads the Sidekick data directory, reports system state, allows KV editing and deletion, exposes tool metadata, accepts webhooks, and proxies agent requests to the Agent Bridge.

It includes dashboard-specific protections: optional Basic Auth, IP allowlist, rate limiting, basic CSRF origin checks, audit logging, and error logging.

### Agent Bridge: `src/agent.js`

The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`, and streams progress events. It also loads scheduled delays and watches at startup.

The agent has a loop limit controlled by `SIDEKICK_MAX_ITERATIONS` and stores transcripts under `data/conversations/`.

## Session handling

The MCP server tracks sessions in memory. Sessions include the MCP server instance, transport, creation time, last access time, and initialization state. Inactive sessions are removed after 24 hours. Streamable HTTP GET and DELETE require a valid `mcp-session-id` header. Stale POST sessions return a structured JSON-RPC error and a replacement session ID header so the client can reinitialize.

## Shared storage

All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example deployment.

Because storage is simple JSON and JSONL files, backups and inspection are straightforward. The tradeoff is that very large data files or concurrent heavy writes can become fragile. Keep logs trimmed, back up state regularly, and avoid using the KV store as a large database.
