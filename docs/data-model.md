# Data Model

Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally inspectable.

## Storage backends

| Storage | Purpose |
|---|---|
| `sidekick.db` (SQLite) | Primary database: KV store, tool logs, named JSON documents, tool registry, tool categories, knowledge base, schema metadata. |
| `audit.jsonl` | Dashboard audit events for mutating API actions. |
| `dashboard-errors.log` | Frontend or dashboard error reports. |
| `json_documents` table | Stores named documents such as `cron`, `webhooks`, `context`, and `watches`. Older constant names remain in code for compatibility, but the active load/save path uses this table. |
| `procedures.json` | Learned procedures used by `sidekick_teach`. |
| `conversations/` | Agent task transcripts. Files older than 30 days are removed on Agent Bridge startup. |
| Additional tool files | Secrets, snapshots, queues, evolve proposals, orchestrations, predictions, health history, baselines, circuits, runbooks, black-box captures, sandbox metadata, anonymization patterns, and other feature state may be stored by their matching tools. |

## SQLite schema

Migrations live under `migrations/` and run automatically when the MCP server starts. The current schema version is stored in `meta.schema_version`.

Core tables:

- `meta`: schema version and other key/value metadata.
- `kv_store`: persistent key/value memory with project and source metadata.
- `json_documents`: named JSON documents used by features that need structured state.
- `tool_logs`: redacted tool call log rows used by the dashboard, metrics collector, and log query tool.
- `tool_categories`: dashboard/tool catalog categories with icons and sort order.
- `tools`: synced tool metadata from `TOOL_DEFS`, including description, args JSON, risk, enabled, deprecated, and updated timestamp.
- `tool_category_map`: many-to-many tool/category mapping.
- `knowledge`: searchable knowledge base entries.

The MCP server calls `runPendingMigrations()` and `syncToolRegistry()` during startup. Removed code tools are not deleted from `tools`; they are marked `deprecated=1` and `enabled=0`.

## KV store (SQLite)

The `kv_store` table stores key-value pairs with metadata:

```sql
CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  project TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Each row's `value_json` column contains a JSON object:

```json
{
  "value": "some value",
  "project": "sidekick",
  "category": "config",
  "source": "mcp",
  "created": "2026-06-13T00:00:00.000Z",
  "updated": "2026-06-13T00:00:00.000Z"
}
```

`sidekick_get` returns only the stored value for backward compatibility. `sidekick_get_by_project` returns key/value pairs for matching project metadata.

## Tool logs

`logToolCall` writes to the `tool_logs` table with fields:

```json
{
  "t": "timestamp",
  "n": "tool_name",
  "a": "formatted redacted args",
  "d": 12,
  "ok": true,
  "s": "redacted summary",
  "src": "mcp"
}
```

The logger truncates argument and summary fields and redacts sensitive strings before writing. The retained row count is controlled by `SIDEKICK_MAX_LOG`.

## Knowledge base

The `knowledge` table is the documentation store for Sidekick's agent-facing operational knowledge. `sidekick_knowledge` supports `search`, `get`, `list`, `add`, `update`, and `delete`. The dashboard exposes a read endpoint at `/api/knowledge`.

Typical query:

```sql
SELECT id, category, title, tags, updated_at
FROM knowledge
WHERE enabled = 1
ORDER BY category, updated_at DESC;
```

## Backup guidance

Back up the entire data directory. The highest-value file is `sidekick.db` because it contains KV data, tool logs, the knowledge base, tool registry metadata, and named JSON documents. Also back up `procedures.json`, `secrets.enc`, and `conversations/` if those matter for your deployment. Treat backups as sensitive operational data.
