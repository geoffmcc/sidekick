# Architecture Boundaries

Sidekick has one governed dispatcher and one durable persistence authority.
Composition roots assemble those services; domain modules own behavior and
repositories own SQL. The repository check is `npm run check:architecture`.

## Allowed Direction

- Platform/core code may expose public interfaces, but does not import bundled
  capability-pack implementations.
- Capability packs depend on public platform interfaces only. They do not
  import Dashboard, Agent HTTP routing, database internals, or transport code.
- Dashboard routes parse HTTP and call application services, repositories, or
  the canonical dispatcher. They do not invoke tool handlers directly.
- Agent execution always calls the canonical dispatcher and never creates a
  second task state machine.
- Tool handlers do not import Dashboard or Agent HTTP servers.
- Repositories do not import Dashboard, MCP transport, Agent HTTP routing, or
  frontend code.
- Provider adapters report through explicit application interfaces and do not
  write application state directly.
- Compute workers accept only typed, allowlisted inference workloads; they do
  not provide arbitrary shell execution.
- Generated tools enter through the canonical registry and dispatcher.

`src/tools-legacy.js` is a compatibility facade. Existing cycles involving the
facade, identity authorization, Compute placement, and module loading are
documented transitional cycles and are not expanded. New cycles elsewhere and
new forbidden dependency directions fail the checker with the import path.

## Composition Roots

`src/dashboard.js` owns Dashboard startup, shared middleware, and route
composition. Database administration routes are owned by
`src/dashboard/database-routes.js`; Agent browser relays are owned by
`src/dashboard/agent-proxy-routes.js`. `src/packs/schema.js` remains a
compatibility export while the platform kernel owns the schema implementation
in `src/platform/capability-pack-schema.js`.
