-- Sidekick knowledge base seed
-- Purpose: populate a fresh Sidekick SQLite database with agent-facing
-- self-knowledge about the current database-first setup.
--
-- Usage on the Sidekick host after migrations have run:
--   cd /home/sidekick/sidekick
--   sqlite3 data/sidekick.db < docs/knowledge-seed.sql
--
-- This file is intentionally not a migration. Re-run safety is handled by
-- deleting only entries with this version_added marker before inserting.
-- The npm helper `npm run seed:knowledge` imports this file only when the
-- knowledge table has zero enabled rows. To add/refresh these seed rows in a
-- database that already has knowledge entries, run:
--   npm run seed:knowledge -- --force
-- That force mode still deletes only rows with the marker below.

BEGIN TRANSACTION;

DELETE FROM knowledge WHERE version_added = 'seed-2026-06-16-current';

INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES
('architecture', 'Database-First Access Model',
'Sidekick runtime knowledge is database-first. Agents should not treat markdown files as the primary runtime source of truth. The database file is SIDEKICK_DB_FILE when set, otherwise SIDEKICK_DATA_DIR/sidekick.db. In the standard deployment this is /home/sidekick/sidekick/data/sidekick.db.

Default retrieval order:
1. Use sidekick_knowledge for documentation, policies, operations, protocols, and architecture.
2. Use sidekick_tools for broad tool overview, grouped manifests, and capability search.
3. Query the tools registry tables for exact current tool metadata.
4. Use KV/context tools for project memory and prior decisions.
5. Read markdown files only when the database entry is missing, stale, or the task is to edit docs.',
'database,agent,access,sqlite,knowledge', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'Authoritative SQLite Tables',
'Core Sidekick tables:
- knowledge: agent-facing documentation and operational knowledge.
- tools: synced tool name, description, args_json, risk, enabled, deprecated, and updated_at metadata.
- tool_categories: category name, icon, and sort_order.
- tool_category_map: tool-to-category mapping.
- kv_store: durable key-value memory with project and source metadata.
- memories: structured automatic and extracted memories with type, project, confidence, source, confirmation, lifecycle, and sync metadata.
- json_documents: named structured documents such as context, cron, webhooks, and watches.
- tool_logs: redacted tool activity history.
- meta: schema metadata including schema_version.

Use sidekick_db_schema to inspect the schema and sidekick_db_query database="sqlite" for exact current rows.',
'database,schema,tables,sqlite', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'Runtime Services',
'Sidekick normally runs three Node.js services:
- sidekick-mcp on port 4097, entry point src/index.js. Exposes MCP Streamable HTTP at /mcp and legacy SSE at /sse.
- sidekick-dashboard on port 4098, entry point src/dashboard.js. Serves the browser UI, JSON APIs, DB tools, tool catalog, and agent proxy.
- sidekick-agent on localhost port 4099, entry point src/agent.js. Runs autonomous goal loops and streams task progress.

Optional infrastructure services include sidekick-postgres, sidekick-redis, sidekick-qdrant, sidekick-influxdb, and sidekick-grafana.',
'services,architecture,ports,systemd', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'MCP Server Behavior',
'The MCP server in src/index.js registers built-in tools from TOOL_DEFS and learned procedures from procedures.json. It supports POST /mcp, GET /mcp, DELETE /mcp, GET /sse, POST /messages, and GET /health.

MCP routes require Authorization: Bearer SIDEKICK_API_KEY or an api_key query parameter. SIDEKICK_ALLOWED_IPS can restrict callers by IPv4 address or CIDR.

Streamable HTTP sessions are held in memory. GET and DELETE require a valid mcp-session-id. Inactive sessions are cleaned up after about one hour. Stale POST sessions return a JSON-RPC error with a replacement session ID header so the client can reinitialize.',
'mcp,sessions,auth,architecture', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'Dashboard Behavior',
'The dashboard in src/dashboard.js serves the HTML app, static assets, dashboard APIs, database inspection APIs, tool metadata APIs, knowledge and procedure APIs, webhook capture, and agent proxy routes.

Important APIs include /api/tools, /api/tool-categories, /api/knowledge, /api/procedures, /api/db/schema, /api/db/query, /api/db/stats, /api/db/search, /api/db/migrations, /api/kv, /api/logs, /api/memories, /api/sync/*, and /api/agent/*.

Dashboard protections include optional Basic Auth, optional dashboard IP allowlist, request size limits, same-origin checks for mutating requests, rate limiting, audit logging, and tool-policy checks for dashboard-originated risky actions.',
'dashboard,api,security,database', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'Agent Bridge Behavior',
'The Agent Bridge in src/agent.js accepts goals, builds a system prompt from policy-filtered tool metadata, asks the LLM for tool-call JSON, executes tools through callTool, streams Server-Sent Events, and writes transcripts to data/conversations.

It tries local Ollama first. If Ollama fails and GROQ_API_KEY is set, it falls back to Groq. The loop stops when the LLM returns done, an error occurs, or SIDEKICK_MAX_ITERATIONS is reached.

The Agent Bridge also loads scheduled delays and active watches at startup. It builds a compact memory brief from structured memories before planning. It is bound to 127.0.0.1 by default and is normally accessed through the dashboard proxy.',
'agent,autonomous,llm,ollama,groq', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'Data Persistence Boundaries',
'SQLite is the primary runtime store for shared state. Use it for KV memory, structured memories, tool logs, the knowledge base, tool registry data, and named JSON documents.

File artifacts still exist where files are the natural representation:
- data/conversations/*.json for agent transcripts.
- data/procedures.json for learned procedures.
- data/secrets.enc for encrypted secrets.
- data/audit.jsonl and data/dashboard-errors.log for dashboard logs.
- feature files for snapshots, queues, evolve proposals, runbooks, baselines, black-box captures, sandbox metadata, and similar bundles.

For new shared feature state, prefer SQLite or json_documents over new ad hoc JSON files.',
'persistence,sqlite,files,state', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Manual Knowledge Seed Import',
'A fresh clone ships without data/sidekick.db. The database is created on startup, migrations create schema, and syncToolRegistry populates tool metadata. Personal runtime data is not shipped.

To seed this knowledge base manually after migrations:
cd /home/sidekick/sidekick
sqlite3 data/sidekick.db < docs/knowledge-seed.sql

This seed deletes and reinserts only entries with version_added = seed-2026-06-16-current. It is not a migration. The deploy scripts call npm run seed:knowledge after npm install; that helper imports the seed only when the knowledge table has zero enabled rows unless --force is supplied.',
'import,seed,knowledge,database', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Fresh Install Database Contents',
'Fresh installs start with an empty runtime database. On first startup, src/db.js creates data/sidekick.db, src/index.js runs pending migrations, and syncToolRegistry inserts the current tool registry and category mappings.

Fresh installs do not include personal KV entries, tool logs, conversations, secrets, procedures, or custom knowledge entries unless explicitly imported. The repository tracks data/.gitkeep only; data/*, .env, and CONTEXT.md are ignored.',
'fresh-install,database,gitignore,deploy', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Deployment Data Preservation',
'The deployment scripts preserve the remote data directory and .env during normal redeploys. They do not import a local database from the repository because data/sidekick.db is ignored and not shipped.

Deploy behavior:
- First deploy can copy .env if no remote .env exists.
- Existing remote .env is preserved.
- Existing remote data/ is backed up and restored when replacing the working tree.
- Remote data ownership is checked and fixed for the sidekick user.

If you want to move data between machines, use sidekick_db_backup/restore or copy data/sidekick.db intentionally.',
'deploy,data,backup,env', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Service Commands',
'Primary systemd services:
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent

Recent logs:
sudo journalctl -u sidekick-mcp -n 100 --no-pager
sudo journalctl -u sidekick-dashboard -n 100 --no-pager
sudo journalctl -u sidekick-agent -n 100 --no-pager

Optional infrastructure services include sidekick-postgres, sidekick-redis, sidekick-qdrant, sidekick-influxdb, and sidekick-grafana.',
'systemd,operations,logs,restart', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Health Checks',
'Useful local health checks:
- MCP server: curl http://127.0.0.1:4097/health
- Agent Bridge: curl http://127.0.0.1:4099/api/health
- Agent status: curl http://127.0.0.1:4099/api/agent/status
- Dashboard system data: curl http://127.0.0.1:4098/api/system

For authenticated MCP health details, send Authorization: Bearer SIDEKICK_API_KEY.',
'health,operations,diagnostics,curl', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Backup and Restore Guidance',
'Back up the entire SIDEKICK_DATA_DIR. The highest-value file is sidekick.db because it contains KV memory, structured memories, tool logs, knowledge entries, tool registry metadata, and named JSON documents.

Also protect:
- secrets.enc if sidekick_secret is used.
- procedures.json if learned procedures matter.
- conversations/ if agent transcripts matter.
- .env because it contains credentials and service settings.

Use sidekick_db_backup for SQLite backup. Treat all backups as sensitive operational data.',
'backup,restore,data,security', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Configuration Defaults',
'Important environment variables:
- SIDEKICK_API_KEY: MCP bearer token.
- SIDEKICK_PORT: MCP port, default 4097.
- SIDEKICK_DASHBOARD_PORT: dashboard port, default 4098.
- SIDEKICK_AGENT_PORT: agent bridge port, default 4099.
- SIDEKICK_DATA_DIR: runtime data directory.
- SIDEKICK_DB_FILE: optional explicit SQLite database file.
- SIDEKICK_MAX_LOG: retained tool log row count.
- SIDEKICK_TOOL_POLICY: open or restricted.
- OLLAMA_URL and OLLAMA_MODEL for local LLM calls.
- GROQ_API_KEY and GROQ_MODEL for Groq.
- SIDEKICK_SECRET_KEY for encrypted secrets.',
'configuration,env,defaults', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Optional Infrastructure',
'Core Sidekick only needs Node.js and SQLite through better-sqlite3. Optional infrastructure extends specific tools:
- PostgreSQL for sidekick_db_* with database="postgres".
- Redis for sidekick_redis and cache workflows.
- Qdrant for vector/semantic context search.
- InfluxDB and Grafana for metrics dashboards.
- Ollama for local LLM and embeddings.
- ffmpeg, ImageMagick, Tesseract, Whisper, and yt-dlp for media tools.
- WireGuard, Nginx, and Cloudflare tunnels for networking tools.',
'optional,infrastructure,services,tools', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Agent Retrieval Protocol',
'When an agent needs information about Sidekick:
1. Search sidekick_knowledge with specific terms.
2. If the question is about available tools, use sidekick_tools action="overview" or sidekick_tools action="search".
3. If the question is about project-specific memory, use sidekick_get, sidekick_delete, sidekick_get_by_project, or sidekick_context.
4. If the question is about recent activity, use sidekick_log_query.
5. Query the tools registry tables when exact raw registry rows are needed.
6. Read markdown files only when the database is missing the answer or when editing documentation.

This keeps prompts small and reduces stale documentation drift.',
'agent,protocol,retrieval,tokens', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Proactive Durable Memory Policy',
'Agents working with Sidekick should proactively store durable findings without waiting for the user to prompt.

Store:
- project policies and workflow preferences.
- root causes and operational gotchas.
- PR and merge rules.
- credential or setup procedures.
- decisions likely to matter in future sessions.

Do not store trivial transient status. If unsure, briefly state what will be stored, then store it with a clear key, category, and project when applicable. Prefer sidekick_knowledge for global agent policy and project-scoped KV for project-specific details.',
'memory,policy,agents,workflow,durable-findings', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Tool Selection Policy',
'Prefer narrow, structured tools before broad tools:
- Use sidekick_mission for broad operational intents before raw shell or ad hoc tool chains.
- Use sidekick_search, sidekick_find, sidekick_filter, and sidekick_summarize before reading huge files.
- Use sidekick_db_schema and read-only sidekick_db_query for database inspection.
- Use sidekick_status or sidekick_health before raw process/service commands.
- Use sidekick_log_query for tool history.
- Use sidekick_bash only when no narrower tool fits.
- Use sidekick_write, sidekick_db_restore, sidekick_evolve, sidekick_runbook, and sidekick_sandbox only when the task explicitly needs their power.',
'tool-selection,best-practices,safety', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Token Efficiency',
'For token efficiency, avoid dumping large files or logs. Search first, then read the smallest relevant slice.

Useful tools:
- sidekick_search for content search.
- sidekick_find for name/date/size/content discovery.
- sidekick_summarize for large files.
- sidekick_filter for filtered file or directory output.
- sidekick_project for consolidated project context.
- sidekick_batch for multiple small calls.
- sidekick_extract for structured field extraction.
- sidekick_tail for recent log slices.',
'tokens,efficiency,search,summarize', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Debugging Workflow',
'Debugging workflow:
1. Reproduce or observe the symptom with the narrowest command/tool.
2. Check service status and recent logs.
3. Query tool_logs for failed tool calls and source context.
4. Inspect configuration through dashboard/API or .env only when necessary.
5. Check migrations and schema if database behavior is involved.
6. Store durable findings with sidekick_context or sidekick_knowledge if they should help future sessions.

Use sidekick_black_box for incident snapshots and sidekick_fresheyes when a second LLM perspective is useful.',
'debugging,workflow,logs,incidents', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Database Query Safety',
'sidekick_db_query defaults to readonly mode. In readonly mode it allows single-statement row-returning SQL only, rejects mutating statements and multi-statement input, and applies row limits.

Use readonly=false only for deliberate maintenance. Prefer sidekick_knowledge, sidekick_store/get/delete, and dedicated feature tools for ordinary writes.

Safe examples:
SELECT id, category, title FROM knowledge WHERE enabled = 1;
SELECT name, risk, enabled FROM tools WHERE deprecated = 0;

Avoid direct writes unless you understand the schema and have a backup.',
'database,safety,readonly,sql', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Documentation Update Policy',
'When Sidekick behavior changes, update both human docs and agent-facing knowledge:
- Human docs live under docs/ and README.md.
- Runtime agent guidance should be inserted into the knowledge table.
- AGENTS.md should stay short and point agents to database-backed knowledge.
- Tool changes should update TOOL_DEFS, TOOL_SCHEMAS, TOOL_CATEGORIES, TOOL_RISK, docs/tools-reference.md, and relevant knowledge entries.

Do not rely only on markdown if the information is needed by agents during normal operation.',
'documentation,knowledge,maintenance', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Security Operating Posture',
'Treat Sidekick as remote shell access. The safest normal posture is private network access plus strong credentials.

Recommended:
- Set a strong SIDEKICK_API_KEY.
- Enable dashboard auth when reachable by browsers.
- Use VPN, SSH tunnel, firewall allowlist, or reverse proxy auth for exposed services.
- Set SIDEKICK_TOOL_POLICY=restricted for shared or public-facing deployments.
- Explicitly allow only needed high/critical tools.
- Protect SIDEKICK_DATA_DIR backups.
- Keep SIDEKICK_SECRET_KEY outside source control.',
'security,operations,policy,exposure', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Risk-Based Tool Policy',
'Tool policy supports global and source-specific controls. Global variables include SIDEKICK_TOOL_POLICY, SIDEKICK_ALLOWED_TOOLS, and SIDEKICK_BLOCKED_TOOLS. Source-specific variants exist for MCP, dashboard, and agent.

restricted mode blocks high and critical tools unless explicitly allowed. Explicit blocklists win. Entries can be tool names or risk selectors such as risk:high and risk:critical.

High or critical tools include operations that can change files, restore databases, manage services, schedule future actions, run shell commands, alter network config, or self-modify procedures.',
'tool-policy,risk,security', 1, 'seed-2026-06-16-current', datetime('now')),

('protocols', 'How To Query Current Tool Metadata',
'Use sidekick_tools action="overview" for broad questions such as "what Sidekick tools are available?", "list available tools", "tool overview", or "tool manifest". Use sidekick_tools action="search" query="database schema" to search capabilities.

Use this SQL through sidekick_db_query database="sqlite" when you need exact current registry rows:

SELECT t.name, t.description, t.risk, tc.name as category, t.args_json
FROM tools t
LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
WHERE t.enabled = 1 AND t.deprecated = 0
ORDER BY tc.sort_order, t.name;

Use this rather than assuming tool lists in markdown are current.',
'tools,sql,protocol,registry', 1, 'seed-2026-06-16-current', datetime('now')),

('protocols', 'How To Query Knowledge',
'Use sidekick_knowledge first for documentation and operational guidance:
- sidekick_knowledge action="search" query="deployment"
- sidekick_knowledge action="list" category="architecture"
- sidekick_knowledge action="get" id=18

Categories used by the default seed include architecture, operations, best-practices, and protocols. Additional categories may exist in a user deployment.',
'knowledge,protocol,search', 1, 'seed-2026-06-16-current', datetime('now')),

('protocols', 'How To Store Durable Project Memory',
'Use sidekick_store for simple durable facts. Use lowercase project names matching /^[a-z][a-z0-9_]*$/.

Examples:
- sidekick_store key="deploy:host" value="YOUR_REMOTE_IP" project="sidekick" category="deployment"
- sidekick_get key="deploy:host"
- sidekick_delete key="deploy:host"
- sidekick_get_by_project project="sidekick"

Use sidekick_context for richer decisions, problems, patterns, session summaries, automatic memories, and recall workflows. The Agent Bridge records bounded, redacted automatic memory summaries for completed tasks and useful tool calls when SIDEKICK_AUTO_MEMORY is enabled.

Structured automatic memory is stored primarily in the memories table. The context document keeps compatibility copies for older context views. Use sidekick_memory_export and sidekick_memory_import for portable JSON backups, sidekick_memory_manage for confirmation/delete/expire/restore workflows, and sidekick_sync_* tools for cross-machine memory synchronization. Semantic recall can use Ollama embeddings and Qdrant when available.',
'memory,kv,context,protocol', 1, 'seed-2026-06-16-current', datetime('now')),

('protocols', 'How To Inspect Recent Tool Activity',
'Use sidekick_log_query for recent tool activity:
- sidekick_log_query limit=20
- sidekick_log_query tool="sidekick_bash" limit=10
- sidekick_log_query source="agent" success=false limit=20

The backing table is tool_logs. It stores timestamp, tool_name, redacted args summary, duration_ms, success, source, summary, and entry_json.',
'logs,tool-activity,protocol,audit', 1, 'seed-2026-06-16-current', datetime('now')),

('protocols', 'How To Add Knowledge Entries',
'Use sidekick_knowledge action="add" for operational knowledge that future agents should retrieve.

Required fields:
- category
- title
- content

Optional:
- tags

Good entries are concise, specific, and operational. Prefer one topic per entry. Add tags for likely search terms. Update existing entries instead of creating duplicates when the title and meaning match.',
'knowledge,authoring,protocol', 1, 'seed-2026-06-16-current', datetime('now')),

('protocols', 'Manual SQL Import Pattern',
'For manual imports into the knowledge table, use a transaction and a version_added marker. Delete only entries with that marker before reinserting, so the seed can be rerun without deleting user-authored knowledge.

Pattern:
BEGIN TRANSACTION;
DELETE FROM knowledge WHERE version_added = ''my-seed-version'';
INSERT INTO knowledge (...) VALUES (...);
COMMIT;

Do not make general DELETE statements against knowledge unless you intend to wipe user content.',
'sql,import,knowledge,protocol', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Common MCP Connection Problems',
'If MCP clients report invalid or stale sessions:
- Restart sidekick-mcp if needed.
- Reinitialize the MCP client session.
- Confirm the client sends Authorization: Bearer SIDEKICK_API_KEY.
- For Streamable HTTP GET/DELETE, confirm mcp-session-id is present and valid.
- Check sudo journalctl -u sidekick-mcp -n 100 --no-pager.

Stale POST sessions should receive a structured JSON-RPC error and a replacement session ID header.',
'mcp,troubleshooting,sessions,operations', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Common Dashboard Problems',
'If the dashboard loads but API calls fail:
- Check SIDEKICK_DASHBOARD_USER and SIDEKICK_DASHBOARD_PASS.
- Check SIDEKICK_DASHBOARD_ALLOWED_IPS.
- Check browser origin and host. Mutating requests are same-origin checked.
- Check data/dashboard-errors.log.
- Check data/audit.jsonl.
- Check sudo journalctl -u sidekick-dashboard -n 100 --no-pager.

The dashboard proxies agent routes to 127.0.0.1:SIDEKICK_AGENT_PORT.',
'dashboard,troubleshooting,auth,operations', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Common Agent Bridge Problems',
'If Agent Bridge tasks do not progress:
- Check sudo journalctl -u sidekick-agent -n 100 --no-pager.
- Check curl http://127.0.0.1:4099/api/agent/status.
- Verify Ollama is reachable if using local LLM.
- Verify GROQ_API_KEY if relying on Groq fallback.
- Check SIDEKICK_MAX_ITERATIONS.
- Check agent tool policy; blocked tools are not offered as enabled.
- Use sidekick_log_query source="agent" success=false for failed calls.',
'agent,troubleshooting,llm,operations', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Packaged Operations Workflows',
'Use sidekick_mission for broad operational intents. It provides run profiles, deterministic routing, preflight checks, and optional execution through safer existing tools before raw shell.

Use sidekick_ops for compact operational verdicts:
- verify_deployed_commit: fetch origin/main, compare HEAD to origin/main, report dirty files, and check core services.
- restart_and_smoke_test: restart sidekick-dashboard and sidekick-agent, check MCP health, and optionally schedule sidekick-mcp restart with restart_mcp=true.
- deploy_current_main: require a clean working tree, fast-forward to origin/main, run npm install --omit=dev, restart dashboard and agent, and schedule MCP restart after the response.
- incident_snapshot: collect service state, resource status, git state, top processes, and recent service logs.

sidekick_mission and sidekick_ops are critical risk because they can deploy code and restart services. MCP self-restarts are scheduled after the response so the caller can receive a verdict before reconnecting.',
'operations,deploy,runbook,workflow,smoke-test,incident', 1, 'seed-2026-06-16-current', datetime('now')),

('development', 'Adding Built-In Tools',
'A built-in tool requires coordinated code updates:
1. Add an async handler in src/tools.js.
2. Add the handler to TOOLS.
3. Add a TOOL_DEFS metadata entry.
4. Add category mapping in TOOL_CATEGORIES.
5. Add risk metadata in TOOL_RISK if default low is wrong.
6. Add a Zod schema in TOOL_SCHEMAS in src/index.js.
7. Add tests.
8. Update docs and knowledge entries.

After restart, syncToolRegistry writes the updated metadata into the database.',
'development,tools,registry,workflow', 1, 'seed-2026-06-16-current', datetime('now')),

('development', 'Knowledge Versus Markdown',
'Markdown docs are useful for humans and repository history. The knowledge table is useful for agents at runtime. Keep both aligned when behavior matters operationally.

AGENTS.md should remain compact and mostly point into the knowledge table and tool registry. Long procedural guidance belongs in knowledge entries. Full explanations belong in docs/ and can be mirrored into knowledge as concise operational entries.',
'development,docs,knowledge,agents', 1, 'seed-2026-06-16-current', datetime('now'));

COMMIT;
