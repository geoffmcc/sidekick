# Development

## Project structure

| Path | Purpose |
|---|---|
| `src/index.js` | MCP server, auth, sessions, Streamable HTTP, legacy SSE, health endpoint. |
| `src/tools.js` | Compatibility re-export to `src/tools/index.js`. |
| `src/tools/index.js` | Public tool facade, compatibility exports, built-in registry construction, and source-specific dispatcher wrappers. |
| `src/tools/descriptor.js` | Tool descriptor normalization and validation. |
| `src/tools/registry.js` | Built-in descriptor registry and alias resolution. |
| `src/tools/dispatcher.js` | Authoritative schema, policy, approval, execution, cancellation, result, and audit boundary. |
| `src/tools/context.js` | Request-scoped source, actor, session, task, project, trace, approval, and cancellation context. |
| `src/tools/families/` | Descriptor-owned extracted tool families. |
| `src/tools-legacy.js` | Remaining legacy handler implementations behind compatibility adapters during the modular migration. |
| `src/compute/` | Compute worker, provider, model, router, job, lease, cancellation, recovery, and artifact implementation. |
| `src/platform/` | Shared execution/event kernel, durable workflows, runners, workspaces, models, extensions, backups, and releases. |
| `src/memory.js` | Automatic memory capture, bounded retention, and recall helpers. |
| `src/db.js` | SQLite database layer, migrations, backups, query helpers, FTS/search helpers, snapshots. |
| `src/pg.js` | Optional PostgreSQL backend for database tools. |
| `src/redis.js` | Optional Redis client for cache operations. |
| `src/qdrant.js` | Optional Qdrant client for vector search. |
| `src/dashboard.js` | Dashboard server, API routes, auth, and agent proxy. |
| `src/dashboard.html` | Authenticated dashboard HTML shell. |
| `static/dashboard.css` | Dashboard styles. |
| `static/dashboard.js` | Dashboard browser-side JavaScript. |
| `src/agent.js` | Autonomous Agent Bridge, task loop, streaming, delays, watches. |
| `src/env.js` | Environment loading. |
| `src/redact.js` | Sensitive output redaction. |
| `docs/` | Existing documentation in the source tree. |
| `systemd/` | Service units and sudoers snippet. |
| `scripts/bootstrap.sh` | Remote bootstrap helper used by deploy scripts. |
| `deploy.sh` | Linux/macOS deploy script. |
| `deploy.ps1` | Windows PowerShell deploy script. |
| `migrations/` | SQLite schema migrations for core storage, tool registry, categories, knowledge base, structured memory, lifecycle, and sync metadata. |
| `test/` | Node.js test suites. |

## npm scripts

```bash
npm start          # node src/index.js
npm run dashboard  # node src/dashboard.js
npm run agent      # node src/agent.js
```

The test runner is `node test/run-all.js`.

## Test coverage in this tree

The test suite covers the registry/descriptor contract, centralized dispatcher, approvals and recovery, authentication and redaction, core tools, memory and handoffs, dashboard APIs, generated tools, platform execution adapters, Compute protocol/jobs/workers/artifacts, deployment behavior, and integration workflows. Specialized suites can also be run directly from `test/`; `npm test` remains the authoritative aggregate check.

## Adding or migrating a tool

New built-in tools should be descriptor-owned rather than added directly to `src/tools-legacy.js`:

1. Add the handler and descriptor in a focused family module under `src/tools/families/`.
2. Provide a Zod schema, human-readable argument metadata, explicit risk, category, source, and family.
3. Register the descriptor family in `src/tools/registry.js`.
4. Add dispatcher-level tests for success, validation failure, policy denial, approvals when relevant, redaction/logging, and compatibility exports.
5. Update the generated/reference documentation and knowledge seed where needed.

When migrating an existing legacy tool, preserve its public name, schema, result shape, risk, category, policy behavior, approval behavior, and tool-log compatibility. Remove the live legacy handler only after the extracted family passes the existing contract and security tests.

Handlers must not implement alternate policy or approval bypasses. Nested tool execution should use an injected or exported dispatcher call path, never a raw handler map.

## Implementation notes

- Keep command construction safe. Prefer `execFileSync` or explicit argument escaping when possible.
- Redact returned and logged output when it may contain secrets.
- Keep output small. Add summaries, filters, or limits for large data.
- Prefer SQLite through `src/db.js` for shared durable state. Use named JSON documents via `loadDocument`/`setDocument` for simple structured feature state. Use files only for artifacts where a file is the natural representation, such as transcripts, encrypted secrets, snapshots, or exported bundles.
- Avoid undocumented environment variables; add them to `.env.example` and `configuration.md`.
- Keep dashboard endpoints consistent with audit logging and CSRF checks when mutating state.
