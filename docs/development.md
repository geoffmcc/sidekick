# Development Guide

## Project Structure

```text
sidekick-main/
  src/
    index.js       MCP server and tool registration
    tools.js       Tool implementations, state helpers, and tool metadata
    dashboard.js   Dashboard web app and API
    agent.js       Autonomous agent bridge
    redact.js      Sensitive-data redaction helpers
  systemd/
    sidekick-mcp.service       MCP server systemd unit
    sidekick-dashboard.service Dashboard systemd unit
    sidekick-agent.service     Agent bridge systemd unit
    sidekick-sudoers           Sudoers config for sidekick user
  test/
    *.test.js      Node-based test files
    run-all.js     Test runner
  data/
    .gitkeep       Placeholder for runtime data directory
  .opencode/
    agents/
      sidekick.md  opencode subagent definition
  package.json
  deploy.sh
  deploy.ps1
```

## Code Organization

### `src/index.js`

Responsibilities:

- Build the MCP server.
- Define Zod schemas for tools.
- Register built-in tools from `TOOL_DEFS`.
- Register learned procedures from `procedures.json`.
- Manage MCP streamable HTTP sessions.
- Serve `/health`, `/mcp`, `/sse`, and `/messages`.
- Enforce MCP API key and optional IP allowlist.

### `src/tools.js`

Responsibilities:

- Implement all built-in Sidekick tools.
- Manage file-backed persistent state.
- Log tool calls.
- Migrate legacy KV data.
- Dispatch internal tool calls with `callTool()`.
- Export metadata for MCP registration and the agent prompt.

### `src/dashboard.js`

Responsibilities:

- Serve the dashboard UI.
- Implement dashboard APIs.
- Enforce dashboard rate limits, size limits, CSRF origin checks, optional Basic auth, and optional IP allowlist.
- Seed system KV data.
- Proxy agent bridge APIs.
- Store webhooks and dashboard error logs.

### `src/agent.js`

Responsibilities:

- Run autonomous task loops.
- Select Groq or Ollama as the LLM backend.
- Stream task events through SSE.
- Save conversation transcripts.
- Suggest reusable procedures from task transcripts.
- Schedule one-shot delays and watches.

### `src/redact.js`

Responsibilities:

- Remove common credentials and tokens from tool output and logs.

## Adding a Built-In Tool

To add a built-in tool:

1. Implement an async function in `src/tools.js`.
2. Add the function to the `TOOLS` export map.
3. Add metadata to `TOOL_DEFS`.
4. Add a Zod schema to `TOOL_SCHEMAS` in `src/index.js`.
5. Add tests under `test/`.
6. Restart the MCP server.

Use `redactSensitive()` on any output that may include command output, HTTP responses, file content, logs, or user-provided text.

## Adding a Learned Procedure

Use `sidekick_teach` with action `teach_procedure`. A procedure contains:

- `name`: procedure identifier.
- `description`: human-readable description.
- `parameters`: optional schema object.
- `steps`: array of Sidekick tool calls.
- `trigger_phrases`: optional phrases for future matching.

After restart, the MCP server registers it as `sidekick_<name>`.

## Testing

The `test/` directory includes tests for:

- Dashboard APIs.
- Integration behavior.
- KV migration.
- New tool behavior.
- Security behavior.
- Core tools.

The package does not define an npm `test` script in `package.json`; use the test runner directly if dependencies are installed:

```bash
node test/run-all.js
```

## Implementation Notes and Review Items

These are observations from the code that are useful for maintainers:

- The dashboard and tools share JSON files without explicit file locking. Concurrent writes can race under heavy usage.
- The MCP session store is in memory and resets on process restart.
- The `OLLAMA_URL` variable is exported but the implemented Ollama calls use hard-coded `127.0.0.1:11434` values.
- The email branch of `sidekick_notify` uses `https.request()` rather than a conventional SMTP transport and should be tested before production use.
- Several tools execute shell commands through `execSync()`. The specific safety level varies by tool.
- `sidekick_process` constructs some commands with pipes by joining an array into a shell command string.
- Learned procedure tools require an MCP restart before they appear in the tool registry.
- Delay and watch scheduling are in memory and depend on the agent bridge being alive.
