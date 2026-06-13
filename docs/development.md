# Development

## Project structure

| Path | Purpose |
|---|---|
| `src/index.js` | MCP server, auth, sessions, Streamable HTTP, legacy SSE, health endpoint. |
| `src/tools.js` | Tool implementations, tool definitions, dispatcher, persistence helpers. |
| `src/dashboard.js` | Dashboard web UI and API. |
| `src/agent.js` | Autonomous Agent Bridge, task loop, streaming, delays, watches. |
| `src/env.js` | Environment loading. |
| `src/redact.js` | Sensitive output redaction. |
| `docs/` | Existing documentation in the source tree. |
| `systemd/` | Service units and sudoers snippet. |
| `scripts/bootstrap.sh` | Remote bootstrap helper used by deploy scripts. |
| `deploy.sh` | Linux/macOS deploy script. |
| `deploy.ps1` | Windows PowerShell deploy script. |
| `test/` | Node.js test suites. |

## npm scripts

```bash
npm start          # node src/index.js
npm run dashboard  # node src/dashboard.js
npm run agent      # node src/agent.js
```

The test runner is `node test/run-all.js`.

## Test coverage in this tree

The supplied tests cover:

- redaction, authentication, and dangerous command handling;
- deployment script structure;
- KV migration behavior;
- core tools and project metadata;
- dashboard API behavior;
- integration workflow for storage and project lookups.

Some future test suites are listed in `test/run-all.js` but not implemented in the supplied tree.

## Adding a tool

A normal tool addition requires changes in two places:

1. Add an async handler function in `src/tools.js`.
2. Add the handler to the `TOOLS` map.
3. Add a user-facing entry to `TOOL_DEFS`.
4. Add a Zod schema in `TOOL_SCHEMAS` in `src/index.js` so MCP clients know the input shape.
5. Add tests for success and failure cases.
6. Update documentation.

Tool handlers should return MCP-style content:

```js
return { content: [{ type: "text", text: "result text" }] };
```

For errors:

```js
return { content: [{ type: "text", text: "error text" }], isError: true };
```

## Implementation notes

- Keep command construction safe. Prefer `execFileSync` or explicit argument escaping when possible.
- Redact returned and logged output when it may contain secrets.
- Keep output small. Add summaries, filters, or limits for large data.
- Store persistent state in the configured data directory, not in the source tree.
- Avoid undocumented environment variables; add them to `.env.example` and `configuration.md`.
- Keep dashboard endpoints consistent with audit logging and CSRF checks when mutating state.
