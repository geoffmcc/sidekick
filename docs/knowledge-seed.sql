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
'Sidekick runtime knowledge is database-first. Agents should not treat Markdown files as the primary runtime source of truth. The database file is SIDEKICK_DB_FILE when set, otherwise SIDEKICK_DATA_DIR/sidekick.db. In the standard deployment it is /home/sidekick/sidekick/data/sidekick.db.

Authoritative runtime areas:
- knowledge: documentation, procedures, policies, operations, architecture, and pack guidance.
- tools, tool_categories, tool_category_map: live tool names, schemas, categories, risk, enabled/deprecated state, and mappings.
- kv_store: compatibility key-value project state; use typed memory and handoff tools when available.
- json_documents: named structured documents such as context, cron, webhooks, and watches.
- memories and memory intelligence tables: bounded typed memories, handoffs, evidence, entities, relationships, task sessions, and audit events when the current migration and registry expose them.
- tool_logs: redacted activity history, useful for recent telemetry but not durable knowledge.

Default retrieval order:
1. Search knowledge for documentation, policies, procedures, operations, and architecture.
2. Use tools action="overview" or action="search" for broad capability discovery.
3. Use tools action="get" and action="policy", or read-only db_query against the registry tables, for exact current schemas and policy.
4. Prefer session, handoff, and memory for scoped continuity when available.
5. Use KV/context/resume compatibility tools when typed memory is unavailable.
6. Read Markdown when the database entry is missing, stale, or the task is editing documentation.

Use secret for credentials, never ordinary KV, context, memory, knowledge, logs, prompts, or source files.',
'database,agent,access,sqlite,knowledge,memory', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'Authoritative SQLite Tables',
'Core Sidekick tables:
- knowledge: agent-facing documentation and operational knowledge.
- tools: synced tool name, description, args_json, risk, enabled, deprecated, and updated_at metadata.
- tool_categories: category name, icon, and sort_order.
- tool_category_map: tool-to-category mapping.
- kv_store: durable compatibility key-value memory with project and source metadata.
- json_documents: named structured documents such as context, cron, webhooks, and watches.
- memories: structured memories with type, project, confidence, source, confirmation, lifecycle, and sync metadata.
- memory_handoffs, memory_evidence, memory_entities, memory_relationships, memory_task_sessions, and memory_audit_events: first-class continuity, provenance, entity, relationship, task-session, and audit artifacts when migration 009_memory_intelligence.sql is applied.
- tool_logs: redacted tool activity history; telemetry is not automatically durable knowledge.
- meta: schema metadata including schema_version.

Use db_schema to inspect the schema and read-only db_query database="sqlite" for exact current rows. Do not assume a table, migration, column, or typed tool exists without checking the live schema and registry.',
'database,schema,tables,sqlite,knowledge,memory', 1, 'seed-2026-06-16-current', datetime('now')),

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

It tries local Ollama first. If Ollama fails and the protected groq_api_key secret file is configured, it falls back to Groq. The loop stops when the LLM returns done, an error occurs, or SIDEKICK_MAX_ITERATIONS is reached.

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
- The protected groq_api_key secret file and GROQ_MODEL for Groq.
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
1. Search knowledge with specific terms for documentation, policies, procedures, operations, and architecture.
2. If the question is about available tools, use tools action="overview" or tools action="search".
3. Before an unfamiliar or consequential call, use tools action="get" name="<canonical>" and tools action="policy" name="<canonical>".
4. If the task is repository work, prefer dev_repo_profile and the Developer pack''s bounded workflows.
5. If the task is broad operations, prefer mission or a documented workflow; inspect ops for packaged deployment and verification actions.
6. If the task is project continuity, prefer session, handoff, memory, and resume; use get, store, context, and project compatibility paths when typed tools are unavailable.
7. If the question is about recent activity, use log_query or the relevant monitoring/evidence tool.
8. Query the tools registry tables when exact raw registry rows are needed.
9. Read Markdown only when the database is missing the answer, the entry is stale, or the task is editing documentation.

When sources disagree, verify current repository/runtime state and update or supersede stale knowledge rather than creating contradictory duplicates. Keep retrieval scoped and do not load unrelated context.',
'agent,protocol,retrieval,tokens,knowledge,tools,memory', 1, 'seed-2026-06-16-current', datetime('now')),

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
'Prefer the narrowest structured tool that can safely complete the task:
- Use a purpose-built Sidekick tool before a broad tool.
- Use mission for broad operational intent when an applicable profile exists.
- Use workflow for durable governed multi-step execution.
- Use ops for packaged deployment, deployed-commit verification, restart smoke tests, and incident snapshots after inspecting its live schema.
- Use dev_repo_profile before ad hoc repository inspection.
- Use status or health before raw process/service commands.
- Use db_schema and read-only db_query for database inspection.
- Use log_query, monitoring, and black_box tools for current evidence and historical incident captures respectively.
- Use search, find, filter, summarize, tail, or batch to bound large inputs when available.
- Use bash only when no narrower suitable tool exists; never use it to bypass a policy block.
- Honor the returned risk, approval, and confirmation requirements.
- Verify consequential postconditions with a fresh independent read.

Do not assume tool names, actions, argument schemas, risk levels, or approval modes from old transcripts. Discover them with tools overview/search/get/policy. Do not claim success, provenance, artifact custody, redaction, or project association beyond returned evidence.',
'tool-selection,best-practices,safety,risk,approval,workflow', 1, 'seed-2026-06-16-current', datetime('now')),

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
'When Sidekick behavior or operating guidance changes, keep the correct layer authoritative:
- Human-facing explanations and repository history live under docs/ and README.md.
- Runtime agent guidance and procedures belong in the knowledge table.
- AGENTS.md is a repository instruction contract. It may contain user-, project-, or repository-specific rules when they are intentionally part of that repository''s contract.
- agents/sidekick.md is the Sidekick execution-subagent contract and may also contain scoped project or user instructions when deliberately configured for that repository.
- Keep stable retrieval rules, safety boundaries, capability families, and tool-selection patterns in source instructions; put detailed shared procedures and changing operational facts in knowledge or the live registry when that is the better maintenance layer.
- Tool changes should update the registry definitions, schemas, categories, risk metadata, relevant docs, and relevant knowledge entries.

Do not commit credentials, raw environment contents, or sensitive private data unless the repository explicitly requires and protects them. Keep transient state out of source instructions unless it is deliberately documented as a rule. Update existing canonical knowledge entries before creating duplicates.',
'documentation,knowledge,maintenance,agents,source', 1, 'seed-2026-06-16-current', datetime('now')),

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

sidekick_knowledge action="delete" is a soft delete that disables an entry. Use action="purge" only to physically remove an already-disabled entry.

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

('protocols', 'When To Recall And Store Project Context',
'Agents should recall project memory before work where prior context can change the safe action:
- deployment, incident response, service operations, or production changes.
- credential, secret, access, auth, or repository history work.
- PR review, merge, release, rollback, migration, or destructive cleanup.
- tasks where the user references earlier work, says "we", "last time", "remember", or asks what is left.
- confusing state where previous decisions, failed attempts, or operational preferences may matter.

Retrieval order for memory:
1. Use sidekick_project name="<project>" include="kv,context" for a broad project brief.
2. Use sidekick_context action="recall" project="<project>" query="<topic>" for focused decisions, problems, patterns, sessions, and automatic memories.
3. Use sidekick_get or sidekick_get_by_project when an exact key or project KV listing is needed.
4. Use sidekick_log_query for recent tool activity and sidekick_knowledge for global docs/protocols.

Store durable memory when future agents would make a better or safer decision from the information:
- track_decision for policies, preferences, PR/merge rules, architecture choices, and rationale.
- track_problem for incidents, root causes, failed approaches, and fixes.
- track_pattern for reusable workflows and operating procedures.
- track_session for meaningful end-of-task summaries.
- sidekick_store for exact lookup keys such as hostnames, paths, feature flags, or named operational notes.
- sidekick_knowledge for global Sidekick documentation, policies, and procedures that should apply beyond one project.

Do not store raw secrets, tokens, private keys, passwords, or full sensitive outputs in KV, context, knowledge, or memories. Use sidekick_secret for credentials. Do not store trivial transient status, command noise, or facts obvious from the current repository. If a note is sensitive but operationally useful, store only the minimum redacted instruction needed for future safety.',
'memory,context,recall,store,protocol,agents', 1, 'seed-2026-06-16-current', datetime('now')),

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

Good entries are concise, specific, and operational. Prefer one topic per entry. Add tags for likely search terms. Update existing entries instead of creating duplicates when the title and meaning match.

Generated or taught material is not durable automatically. After review, use sidekick_knowledge action="promote" with source="evolve" for an active successfully trialed Evolve capability or source="procedure" for a named taught procedure, plus category and an explicit approver. Promotion redacts sensitive fields, records source/version/provenance metadata, and is idempotent for the same source version.',
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
- Verify the protected groq_api_key secret file if relying on Groq fallback.
- Check SIDEKICK_MAX_ITERATIONS.
- Check agent tool policy; blocked tools are not offered as enabled.
- Use sidekick_log_query source="agent" success=false for failed calls.',
'agent,troubleshooting,llm,operations', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Packaged Operations Workflows',
'Use mission for broad operational intents. It provides run profiles, deterministic routing, preflight checks, and optional execution through safer existing tools before raw shell.

Inspect the live ops schema before use. The packaged ops actions are:
- verify_deployed_commit: fetch origin/main, compare the deployed checkout with origin/main, report dirty/ahead/behind state, and verify core services.
- restart_and_smoke_test: restart the governed Sidekick services, check MCP health, and optionally schedule a sidekick-mcp restart with restart_mcp=true.
- deploy_current_main: require the applicable clean-tree/preflight conditions, advance to origin/main, install production dependencies as defined by the live workflow, restart services, and schedule MCP restart when required.
- incident_snapshot: collect bounded service, resource, Git, process, and recent-log evidence.

Use mission for routing/preflight and ops for these specialized operational verdicts. A successful mutation or script exit is not deployment proof; verify the deployed commit and service health. Honor policy and approval results. MCP self-restarts are scheduled after the response when the workflow requires it so the caller can receive a verdict before reconnecting.',
'operations,deploy,runbook,workflow,smoke-test,incident,ops', 1, 'seed-2026-06-16-current', datetime('now')),

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
'Markdown docs are useful for humans and repository history. The knowledge table and live tool registry are useful for agents at runtime. Keep the layers aligned when behavior matters operationally.

AGENTS.md is a repository instruction contract, not necessarily a generic-only file. It may contain user-, project-, or repository-specific instructions that future agents need to follow. agents/sidekick.md is the execution-subagent contract and may likewise be scoped intentionally to a repository or project. Long shared procedural guidance belongs in knowledge entries; source files should retain whatever local instructions are necessary for correct work.

When guidance changes:
1. Update the canonical knowledge entry or create one only if no suitable entry exists.
2. Update source instructions for stable bootstrap, routing, safety, verification, or intentionally scoped project/repository rules.
3. Do not commit credentials, raw environment contents, or sensitive private data unless explicitly required and protected.
4. Verify that future agents can discover the entry through knowledge search and the relevant tool schema through the live registry.',
'development,docs,knowledge,agents,source', 1, 'seed-2026-06-16-current', datetime('now')),

('best-practices', 'Agent autonomy for low-risk follow-through',
'When an agent identifies a low-risk follow-up that is clearly part of the active task, the agent should do it immediately instead of only suggesting it or waiting for a separate go-ahead. This includes updating Sidekick resume keys, cleanup notes, documentation or handoff records, and running reasonable verification commands.

Agents should still ask first before destructive actions, broad refactors, deploys, merges, credential or secret changes, production-impacting operations, or changes that could affect unrelated user work.

Use generic agent language in project policies so the guidance applies across tools and clients, not just one agent implementation. Prefer storing durable operating policies in the Sidekick knowledge base, with AGENTS.md acting as a pointer to retrieve project policy and operating knowledge from the database first.',
'agent-policy,autonomy,handoff,best-practices', 1, 'seed-2026-06-16-current', datetime('now')),

('architecture', 'Sidekick Capability Map and Live Discovery',
'Sidekick exposes a broad governed capability surface. This map helps agents choose a family; the live registry remains authoritative for exact names, schemas, risk, policy, and availability.

Capability families include:
- Core interaction and remote access: bounded read/write/list/search, bash, web_fetch, llm, and respond.
- Storage and project state: KV/store, project registry, Redis, and encrypted workspace.
- Databases and analytics: schema, read-only/query, search, stats, backup, restore, export, diff, migration, and analytics.
- Git and development: repository profiling, change summaries, verification, Git, GitHub, CI, changelog, and dependency tools.
- Services and infrastructure: process, service, module, capability-pack lifecycle, Proxmox, and Ansible.
- Operations and workflows: mission, workflow, ops, runbook, retry, queue, and orchestrate.
- Scheduling and communication: cron, delay, notifications, and webhooks.
- Monitoring and evidence: status, health, metrics, baselines, snapshots, timelines, logs, tailing, watches, network diagnostics, and Black Box.
- Context and learning: knowledge, context, sessions, handoffs, typed memory, teaching, embeddings, portability, and model administration.
- Compute: provider-neutral providers, models, workers, jobs, routing, LLM, and embedding paths; Ollama is administration, not a separate inference route.
- Data and media: bounded transformation, parsing, diffing, hashing, validation, templating, extraction, anonymization, reporting, media, download, OCR, transcription, and Jellyfin.
- Security and reliability: secrets, security scanning, sandbox rollback, connectors, circuit breakers, and authorized security research.
- Efficiency and meta-tools: batch, cache, summarize, filter, project scoping, find, evolution, prediction, debugging memory, and independent review.
- Archive operations: bounded archive creation, extraction, and listing.

Installed or bundled capability packs must be discovered with capability action="list"/"available"; inspect before install or enable because pack activation runs executable module code. Registered workflows must be discovered with workflow action="list"/"show" and run through workflow, not recreated ad hoc. Prefer purpose-built tools and workflows over raw shell, honor policy/approval, and verify consequential results with fresh evidence.',
'capabilities,tools,registry,packs,workflows,discovery', 1, 'seed-2026-06-16-current', datetime('now'));

INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES
('operations', 'Deployment and Bootstrap Repair',
'Normal deploys update the application and restart the core Node services. First deploy/bootstrap should install the optional tooling stack by default unless the minimal flag is explicitly passed.

If a first bootstrap misses optional tooling, rerun the tooling install path as a repair step rather than resetting the machine. That repair path should bring up missing Docker-backed services and install missing wrappers without wiping existing bind-mounted data or recreating persistent state.

Never delete docker/data directories or Docker volumes unless an explicit destructive reset is requested.',
'deploy,recovery,bootstrap,docker,full-stack', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Service Startup and Health',
'Core health means sidekick-mcp, sidekick-dashboard, and sidekick-agent are active. Optional infrastructure is separate and runs through Docker Compose wrappers: sidekick-postgres, sidekick-redis, sidekick-qdrant, sidekick-influxdb, and sidekick-grafana.

Treat active wrappers and healthy containers as different signals: the wrapper can be active even when a container is not yet ready. For the optional stack, verify docker ps and service logs when a container is missing or unhealthy.

Use the core service checks for routine deploy verification, and inspect optional infrastructure separately when metrics, vector search, persistence, or dashboards are expected.',
'services,health,startup,docker,grafana', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Resume and Handoff Conventions',
'Use resume_* keys for project-level handoffs and pending work. Keep the current thread''s remaining work together in one resume record unless a distinct project or phase needs its own handoff.

A resume entry should capture the current summary, the next concrete step, and any branch, URL, or notes needed to continue later. Append new context to the existing handoff instead of replacing unrelated pending work.

Handoff plans are independent named sequences. Phase numbers are scoped to the named plan, not the project. Never treat the highest phase number found in Git history as the starting point for unrelated work. When starting a new named handoff plan, begin at Phase 1. When continuing an existing plan, determine its last completed phase from stored state and continue its local sequence.

Use sidekick_resume with plan_name and current_phase fields to record the plan identity and current phase. Mark a plan complete with status "complete" or "done" when all phases are finished.

Keep AGENTS.md compact and use it as a pointer to the database-first knowledge base and resume records.',
'handoff,resume,kv,workflow,project-state,phases,plans', 1, 'seed-2026-06-16-current', datetime('now'));

INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES
('operations', 'Health Check Expectations and Probe Behavior',
'Use sidekick_health check=services for a quick core-service verdict and check=all for a stable composite report covering services, processes, disk, and network. Subcheck command failures retain predictable empty result shapes and appear as issues instead of crashing report rendering.

Packaged restart smoke checks probe the MCP /health endpoint asynchronously. This is required because sidekick_ops executes inside the MCP process; a synchronous self-probe blocks the event loop and times out waiting for its own request.

Treat an isolated probe warning as diagnostic evidence and verify service state and recent logs, but do not treat the old deterministic self-timeout as expected behavior.',
'health,operations,mcp,probe,troubleshooting', 1, 'seed-2026-06-16-current', datetime('now')),

('protocols', 'Handoff Plan Phase Scoping',
'Handoff plans are named, independent sequences. Phase numbers are local to each plan and must never be treated as a global project-wide sequence.

Before assigning a phase number:
1. Determine whether work continues an existing named handoff plan or starts a new plan.
2. When continuing an existing plan, inspect that plan''s stored state and Git history to find the last completed phase belonging to that specific plan, then continue its local sequence.
3. When starting a new plan, assign a descriptive plan name and begin at Phase 1.
4. Never search Git history for the highest Phase N value and increment it for unrelated work.

Use sidekick_resume with plan_name and current_phase fields to record plan identity and phase. Mark complete plans with status "complete".

Treat historical unnamed phase references as belonging to their established historical handoff only when repository context or existing Sidekick state supports that conclusion. Do not rewrite historical commits or records.

When the plan identity is ambiguous, prefer a safe new named plan at Phase 1 over accidental continuation of an unrelated sequence.',
'handoff,phases,plan,protocol,agents', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Optional Infrastructure Startup Order',
'Optional infrastructure runs through Docker Compose wrappers backed by systemd. Start Docker first, then the wrapper services for postgres, redis, qdrant, influxdb, and grafana.

Grafana and InfluxDB should be treated as ready only after their container health checks pass. A wrapper being active is not enough by itself.

If optional services are expected but missing, check docker ps, the wrapper service status, and the wrapper logs before assuming data loss or a broken install.',
'docker,services,optional,infrastructure,startup,grafana', 1, 'seed-2026-06-16-current', datetime('now')),

('operations', 'Safe Recovery Versus Destructive Reset',
'Rerun setup-tools or the optional infrastructure install path when the goal is to repair or complete a missing stack. That path should preserve existing bind-mounted data and only create what is missing.

Do not delete data directories, prune volumes, or reinitialize containers unless the user explicitly requests a destructive reset.

If state is missing unexpectedly, verify the deploy path, container startup, and filesystem mounts before changing data.',
'recovery,data,safety,deploy,reset', 1, 'seed-2026-06-16-current', datetime('now'));

INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES
('best-practices', 'Approval Queue Security',
'The approval queue is optional and defaults to off. It applies only to tools already allowed by tool policy; approval never enables a blocked tool. Use risky mode for critical tools or strict mode for high and critical tools, with global or source-specific required and exempt lists.

Enabling approvals requires SIDEKICK_SECRET_KEY. Sidekick encrypts full queued arguments with AES-256-GCM, exposes only structurally redacted previews, and removes payloads after approval, rejection, failure, or expiry. If the encryption key is unavailable, Sidekick refuses to queue a new action rather than storing plaintext.

Pending approvals expire after SIDEKICK_APPROVAL_TTL_SECONDS, default 3600 seconds. Approval execution rechecks the current tool policy under the original request source and bypasses only the approval check, so a request blocked after queueing remains blocked.',
'approval,security,tool-policy,encryption,dashboard', 1, 'seed-2026-06-16-current', datetime('now'));

INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES
('best-practices', 'Configuration and Secret Exposure Scanning',
'Use sidekick_security_scan for a read-only audit before deployments or after configuration changes. It checks for tracked sensitive files, private-key and high-confidence credential signatures, hardcoded sensitive configuration values or fallbacks, generated credential filenames, runtime .env security keys, and permissive sensitive-file modes.

The scanner reports metadata only: paths, configuration key names, line numbers, categories, and severity. It never returns matched secret values. It obeys global and source-specific filesystem path policy, skips denied descendants, ignores runtime data/dependency/documentation/test content, and bounds work with max_files.

Treat findings as inputs to a separate deliberate remediation workflow. Rotate exposed credentials, remove tracked secrets from history, replace hardcoded defaults with secret injection, and restrict file permissions only after reviewing operational impact.',
'security,secrets,configuration,audit,scan,path-policy', 1, 'seed-2026-06-16-current', datetime('now'));

COMMIT;
