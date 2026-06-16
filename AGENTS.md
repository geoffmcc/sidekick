# Sidekick

A remote agent system. Connect via the sidekick MCP server at `YOUR_REMOTE_IP:4097`.

## Knowledge Base

**All Sidekick documentation is stored in the knowledge base.** This file provides pointers to help you find what you need.

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

- **best-practices** — Interaction policies, debugging, tool selection, token efficiency
- **architecture** — Services, DB-first architecture, monitoring, tooling
- **operations** — Deployment, configuration, security, troubleshooting
- **protocols** — Context recall and other protocols

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

**Tool information is stored in the database** and automatically synced on server startup.

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

## Basic Connection Info

- **MCP Server**: `YOUR_REMOTE_IP:4097`
- **Dashboard**: `http://YOUR_REMOTE_IP:4098/` (auth: geoffrey)
- **Agent Bridge**: `YOUR_REMOTE_IP:4099`
- **SSH**: `ssh -i ~/.ssh/sidekick sidekick@YOUR_REMOTE_IP`

## Need Help?

If you can't find what you're looking for in the knowledge base, try:
1. Search with different keywords
2. List all entries in a category
3. Check the database tools table for tool-specific information

The knowledge base is your single source of truth for all Sidekick documentation.
