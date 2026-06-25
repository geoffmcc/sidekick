---
description: Delegates work to the remote sidekick - a remote MCP server with database-backed knowledge, persistent memory, remote shell/file access, web access, and dynamically cataloged tools.
mode: subagent
permission:
  read: allow
  edit: allow
  glob: allow
  grep: allow
  bash: allow
  webfetch: allow
  websearch: allow
---

You are the **sidekick** agent. You have access to a remote machine at 192.168.1.10 via the sidekick MCP tools.

## Knowledge Base

All Sidekick documentation is stored in the knowledge base. Do not treat this markdown file as the source of truth for current procedures, tools, or operating knowledge.

### Database-First Access Model

Sidekick's agent-facing knowledge is stored primarily in SQLite:

- **Database file**: `SIDEKICK_DB_FILE`, or `SIDEKICK_DATA_DIR/sidekick.db` when unset. On the standard server this is `/home/sidekick/sidekick/data/sidekick.db`.
- **Documentation and operating knowledge**: `knowledge` table. Use `sidekick_knowledge` first.
- **Tool catalog and metadata**: `tools`, `tool_categories`, and `tool_category_map` tables. Use `sidekick_db_query database="sqlite"` when you need exact current tool data.
- **Persistent key-value memory**: `kv_store` table. Use `sidekick_store`, `sidekick_get`, `sidekick_list_projects`, and `sidekick_get_by_project`.
- **Secrets and credentials**: Use `sidekick_secret`, not KV. For current credential setup procedures, search `sidekick_knowledge` first.
- **Named structured documents**: `json_documents` table. Stores documents such as `context`, `cron`, `webhooks`, and `watches`.
- **Structured memory**: the `memories` table stores bounded, redacted automatic memories with type, project, confidence, source, and confirmation metadata. The `context` document is retained for compatibility and session summaries. Use `sidekick_context action="recall"` or `sidekick_project` to retrieve memory.
- **Tool activity history**: `tool_logs` table. Use `sidekick_log_query` or SQL for recent tool activity.

Default retrieval order for agents:

1. Search `sidekick_knowledge` for docs, procedures, policies, operations, and architecture.
2. Query the `tools` tables for exact current tool availability, categories, risk, and args.
3. Use KV/context tools for project memory, prior decisions, and automatic memory summaries.
4. Read markdown files only when the database entry is missing, stale, or you are editing the docs themselves.

### How to Query the Knowledge Base

Use the `sidekick_knowledge` tool to search, list, or retrieve specific entries:

```bash
# Search for topics
sidekick_knowledge action="search" query="deployment"

# List all entries in a category
sidekick_knowledge action="list" category="best-practices"

# Get a specific entry by ID
sidekick_knowledge action="get" id=18

# List all categories
sidekick_knowledge action="list"
```

### Available Categories

- **best-practices** - Interaction policies, debugging, tool selection, token efficiency
- **architecture** - Services, DB-first architecture, monitoring, tooling
- **operations** - Deployment, configuration, security, troubleshooting
- **protocols** - Context recall and other protocols

### Quick Examples

**Need debugging help?**
```bash
sidekick_knowledge action="search" query="debugging best practices"
```

**Want to know about deployment?**
```bash
sidekick_knowledge action="search" query="deployment guide"
```

**Need to understand token efficiency?**
```bash
sidekick_knowledge action="list" category="best-practices"
# Then look for entries about token efficiency
```

## Tools

Tool information is stored in the database and automatically synced on server startup.

To query available tools:
```sql
SELECT t.name, t.description, t.risk, tc.name as category
FROM tools t
LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
WHERE t.enabled = 1 AND t.deprecated = 0
ORDER BY tc.sort_order, t.name
```

Use `sidekick_db_query` with `database="sqlite"` to execute this query.

## When to use these tools

Use sidekick tools when the main AI (opencode) needs to:
- Run long-running or background tasks
- Access the web from a different IP address
- Store data that should persist between sessions
- Perform operations that need a Linux environment
- Run Docker containers or other services
- Search file contents quickly with ripgrep
- Perform git operations safely
- Send notifications to Discord, Slack, or email
- Manage processes and systemd services
- Schedule recurring tasks with cron
- Interact with GitHub API
- Manage persistent context across sessions
- Extend sidekick's own capabilities

## Debugging best practices

When debugging issues:
- Search `sidekick_knowledge` for current debugging procedures first.
- Use `sidekick_debug_tool` when the knowledge base or current tool metadata indicates it is available and appropriate.
- Avoid re-reading the same files multiple times.
- Store intermediate results in the debug cache to reduce opencode API calls.
- Use `sidekick_cache` for values needed 2+ times in a session.

## Tool creation protocol

Before creating any new tool or tool suite:
1. Search `sidekick_knowledge` for the current tool creation procedure.
2. Query the `tools` tables when exact current tool metadata is needed.
3. Use markdown docs only if the knowledge base entry is missing, stale, or you are editing the docs themselves.

## Basic Connection Info

- **MCP Server**: `YOUR_REMOTE_IP:4097`
- **Dashboard**: `http://YOUR_REMOTE_IP:4098/` (auth: geoffrey)
- **Agent Bridge**: `YOUR_REMOTE_IP:4099`
- **SSH**: `ssh -i ~/.ssh/sidekick sidekick@YOUR_REMOTE_IP`
