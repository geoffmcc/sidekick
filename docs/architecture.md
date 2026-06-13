# Architecture

## Overview

Sidekick is a Node.js application split into three cooperating services:

- `src/index.js`: the MCP server exposed to MCP clients such as opencode.
- `src/dashboard.js`: an Express dashboard and API server.
- `src/agent.js`: an autonomous agent bridge that runs locally and is proxied through the dashboard.

The shared tool implementations live in `src/tools.js`. The redaction engine lives in `src/redact.js` and is used before tool outputs are returned or logged.

## Runtime Topology

```text
opencode or MCP client
        |
        | Bearer token or api_key
        v
+-------------------------+
| MCP Server :4097        |
| src/index.js            |
| /mcp, /sse, /messages   |
+-----------+-------------+
            |
            | calls
            v
+-------------------------+
| Tool Registry           |
| src/tools.js            |
+-----------+-------------+
            |
            | reads/writes
            v
+-------------------------+
| SIDEKICK_DATA_DIR       |
| JSON and JSONL files    |
+-------------------------+

Browser
   |
   v
+-------------------------+        loopback proxy        +-------------------------+
| Dashboard :4098         |----------------------------->| Agent Bridge :4099      |
| src/dashboard.js        |                              | src/agent.js            |
+-------------------------+                              +-------------------------+
```

## MCP Server

The MCP server is created with `McpServer` from `@modelcontextprotocol/sdk`. It registers each entry in `TOOL_DEFS` and maps the tool name to a Zod input schema in `TOOL_SCHEMAS`.

Each tool call follows this flow:

1. MCP client calls a registered Sidekick tool.
2. `src/index.js` sets the source to `mcp`.
3. The matching handler in `TOOLS` runs.
4. Output is redacted where implemented by the tool.
5. `logToolCall()` appends a compact record to `log.jsonl`.
6. The MCP server returns the tool result.

The MCP server supports streamable HTTP at `/mcp` and a legacy SSE transport at `/sse` and `/messages`.

## Session Handling

The streamable HTTP implementation stores sessions in memory. A session record contains the server instance, transport, creation time, last access time, and initialized state.

Important session behavior:

- Session IDs are UUID-like values generated server-side.
- Inactive sessions are evicted after 24 hours.
- A cleanup interval runs every 10 minutes.
- A stale session can be mapped to a new session to guide clients toward reinitialization.
- The `/health` endpoint returns session count, session details, stale mapping count, uptime, version, and timestamp.

Because sessions are in memory, restarting the MCP service invalidates active sessions. Clients must reconnect and initialize again.

## Dashboard

The dashboard is an Express application that serves a browser UI and JSON API. It reads the same data directory as the tools. It provides API endpoints for:

- Tool logs.
- KV storage.
- System metrics.
- Service status.
- Configuration summary.
- Dashboard statistics.
- Webhook ingestion.
- Agent bridge proxying.
- Data clearing and reset operations.

At startup, the dashboard seeds system information into the KV store if those keys are missing. Seeded keys include server information, network information, service status, security settings, software versions, deployment metadata, and configuration metadata.

## Agent Bridge

The agent bridge listens on `127.0.0.1` by default. It is intended to be accessed through the dashboard rather than exposed publicly.

A task run works as follows:

1. The dashboard posts a goal to `/api/agent/run`.
2. The agent creates a short task ID and an event emitter.
3. The agent builds a system prompt from the current tool registry.
4. The configured LLM returns raw JSON instructions.
5. The agent either records a thought, calls a tool, or marks the task done.
6. Events are streamed as Server-Sent Events.
7. A transcript is written under `data/conversations`.
8. If Groq is configured, the agent may ask the LLM whether the workflow should be saved as a reusable procedure.

The agent includes safeguards against repeated identical tool calls and limits each task with `SIDEKICK_MAX_ITERATIONS`.

## Shared Tool Layer

`src/tools.js` contains all first-party tool handlers, persistent storage helpers, logging, redaction integration, and dynamic procedure execution support.

The file exports:

- `TOOLS`: map from tool name to async function.
- `TOOL_DEFS`: MCP-facing tool metadata.
- `callTool()`: internal tool dispatcher used by agent, delays, queue, retry, orchestration, watches, and procedures.
- Persistent-state helpers such as `loadProcedures()`, `loadDelays()`, and `loadWatches()`.
- Runtime configuration constants such as `DATA_DIR`, `OLLAMA_URL`, `GROQ_API_KEY`, and `GROQ_MODEL`.

Tool categories include:
- **Core Operations**: bash, read, write, list, search, git
- **Storage & Context**: store, get, context, teach
- **Web & Communication**: web_fetch, llm, notify, github, webhook
- **Remote Management**: process, service, archive
- **Automation**: cron, delay, watch, queue, retry
- **Observability**: health, snapshot, timeline, baseline, black_box
- **Security**: secret, anonymize
- **Data Utilities**: parse, transform, diff, hash, validate, template
- **Advanced Intelligence**: evolve, orchestrate, predict
- **Token Efficiency**: batch, cache, summarize, filter, project, tail, diff_files, find, status, extract
- **Safety & Reliability**: sandbox, circuit
- **Development**: changelog, depend
- **Operations**: runbook
- **Diagnostics**: netdiag

## Dynamic Procedures

`sidekick_teach` stores procedure definitions in `procedures.json`. On MCP server startup, `src/index.js` loads procedures and registers each one as a new MCP tool named `sidekick_<procedure_name>` unless that name conflicts with a built-in tool.

A procedure contains a description, a parameter schema, and a sequence of tool calls. Parameters are substituted into step arguments when the procedure executes.

Because procedure tools are registered at startup, newly taught procedures become MCP-visible after the MCP server restarts.
