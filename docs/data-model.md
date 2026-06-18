# Data Model

Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally inspectable.

## Storage backends

| Storage | Purpose |
|---|---|
| `sidekick.db` (SQLite) | Primary database: KV store, structured memories, tool logs, named JSON documents, tool registry, tool categories, knowledge base, schema metadata. |
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
- `memories`: structured memory rows with type, project, confidence, source, and confirmation metadata.
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

## Structured memory

The `memories` table is the primary store for automatic and extracted memories:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  tags TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT,
  source_tool TEXT,
  source_task_id TEXT,
  source_ref TEXT,
  metadata_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  automatic INTEGER NOT NULL DEFAULT 1,
  times_confirmed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_confirmed_at TEXT,
  expires_at TEXT,
  -- Sync and origin tracking (migration 005)
  origin_machine_id TEXT,
  origin_user_id TEXT,
  sync_version INTEGER DEFAULT 1,
  last_synced_at TEXT,
  -- Lifecycle and state tracking (migration 006)
  state TEXT DEFAULT 'active',
  requires_confirmation INTEGER DEFAULT 0,
  confirmed_by TEXT,
  deleted_at TEXT,
  expired_at TEXT
);
```

Supported memory types are `fact`, `decision`, `preference`, `procedure`, `open_thread`, `observation`, `session`, and `tool_call`. The first pass writes automatic `session` and `tool_call` memories and performs simple extraction into `fact`, `decision`, `preference`, `open_thread`, and `observation` rows when task text matches those patterns. Repeated matching memories update the existing row and increment `times_confirmed` rather than inserting duplicates.

### Conflict Detection and Supersession

When a new `fact`, `decision`, `preference`, `procedure`, `open_thread`, or `observation` memory is similar enough to an existing active row but not identical, the older row is marked `enabled = 0` and its metadata is updated with `state = superseded` plus a pointer to the replacement row. Conflict detection is confidence-aware: low-confidence memories cannot supersede high-confidence ones. Confirmed memories with `requires_confirmation = 1` are protected from auto-supersession.

### Memory Lifecycle

Memories have a full lifecycle with states: `active`, `pending`, `confirmed`, `superseded`, `expired`, `deleted`.

- **Confirmation workflow**: Memories with `requires_confirmation = 1` start as `pending` and require explicit confirmation via `sidekick_memory_manage` action `confirm`.
- **Soft-delete**: Memories can be soft-deleted with `deleted_at` timestamp and reason tracking. Deleted memories can be restored.
- **Expiration**: Memories can be manually expired or auto-expired based on `expires_at`. Expired memories can be restored.
- **Auto-expiration**: Memories not confirmed within 90 days are automatically expired by `expireStaleMemories`.
- **Decay scoring**: Memory confidence decays based on recency of confirmation and frequency of use.

### Cross-Machine Sync

Memories track their origin for cross-machine synchronization:

- **origin_machine_id**: UUID of the machine where the memory was created
- **origin_user_id**: User ID associated with the memory
- **sync_version**: Version counter for sync conflict resolution
- **last_synced_at**: Timestamp of last sync operation

Sync export/import supports 5 conflict resolution strategies: newest, highest_confidence, most_confirmed, merge, and skip.

Automatic memory is enabled by default, can be disabled with `SIDEKICK_AUTO_MEMORY=0`, and is capped by `SIDEKICK_AUTO_MEMORY_MAX` active automatic rows. It stores redacted summaries and metadata, not full raw outputs. Semantic memory recall can use Ollama embeddings and Qdrant when `SIDEKICK_EMBEDDINGS` is enabled and the optional services are available.

## Context compatibility

The `context` document in `json_documents` stores structured continuity data:

- `projects`
- `decisions`
- `problems`
- `patterns`
- `sessions`
- `memories`

Explicit context entries are written through `sidekick_context`. Automatic memory still mirrors bounded entries into `context.memories` and `context.sessions` for compatibility with older context views, but the `memories` table is the primary queryable store.

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

Back up the entire data directory. The highest-value file is `sidekick.db` because it contains KV data, structured memories, tool logs, the knowledge base, tool registry metadata, and named JSON documents. Also back up `procedures.json`, `secrets.enc`, and `conversations/` if those matter for your deployment. Treat backups as sensitive operational data.
