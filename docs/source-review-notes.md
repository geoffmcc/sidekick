# Source Review Notes

This documentation package was rebuilt after reviewing the uploaded `sidekick-main(1).zip` source tree.

## Confirmed source facts

- Package name: `sidekick`.
- Main entry: `src/index.js`.
- Runtime scripts: `start`, `dashboard`, and `agent`.
- Main dependencies include the MCP SDK, Express, CORS, Zod, AJV, YAML, INI, fast XML parser, and Handlebars.
- The project defines three Node services: MCP server, dashboard, and agent bridge.
- The tool module exports 60 tool handlers through the `TOOLS` map and 60 dashboard-facing entries through `TOOL_DEFS`.
- The systemd units expect the project at `/home/sidekick/sidekick` and run as user/group `sidekick`.
- The default service ports are 4097, 4098, and 4099.
- Persistent data is file-backed under `SIDEKICK_DATA_DIR`.

## dashboard-password-from-local-test-datable correction from older docs

Older text in the repository mentions 59 tools. The reviewed `src/tools.js` currently includes 60 exported `sidekick_*` handlers because `sidekick_respond` is also present in `TOOLS` and `TOOL_DEFS`.

## Files reviewed

- `package.json`
- `.env.example`
- `src/index.js`
- `src/tools.js`
- `src/dashboard.js`
- `src/agent.js`
- `src/redact.js`
- `systemd/*`
- `deploy.sh`
- `deploy.ps1`
- `scripts/bootstrap.sh`
- `test/*.js`
- existing `README.md`, `AGENTS.md`, `MIGRATION.md`, `ROADMAP.md`, and `docs/*.md`
