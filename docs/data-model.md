# Data Model

Sidekick stores persistent state in SQLite (`sidekick.db`) and JSON/JSONL files under `SIDEKICK_DATA_DIR`.

## Storage backends

| Storage | Purpose |
|---|---|
| `sidekick.db` (SQLite) | KV store (`kv_store` table), tool logs (`tool_logs` table), JSON documents (`json_documents` table), metadata (`meta` table). |
| `log.jsonl` | Legacy tool call log file. Trimmed to the newest 1000 entries. |
| `audit.jsonl` | Dashboard audit events for mutating API actions. |
| `dashboard-errors.log` | Frontend or dashboard error reports. |
| `cron.json` | Sidekick-managed cron metadata. |
| `webhooks.json` | Stored webhook payloads received through dashboard API. |
| `context.json` | Structured project context, decisions, problems, patterns, sessions, and related data. |
| `procedures.json` | Learned procedures used by `sidekick_teach`. |
| `conversations/` | Agent task transcripts. Files older than 30 days are removed on Agent Bridge startup. |
| Additional tool files | Snapshots, queues, caches, baselines, circuits, runbooks, black-box captures, and other feature state may be stored by their matching tools. |

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

## Tool log schema

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

The logger truncates argument and summary fields and redacts sensitive strings before writing.

## Backup guidance

Back up the entire data directory. The highest-value file is `sidekick.db` (contains all KV data, tool logs, and JSON documents). Also back up `context.json`, `procedures.json`, `webhooks.json` if used, and `conversations/` if task transcripts matter. Logs and caches are usually lower value.
