# Data Model

Sidekick stores persistent state as JSON and JSONL files under `SIDEKICK_DATA_DIR`.

## Important files

| File or directory | Purpose |
|---|---|
| `kvstore.json` | Persistent key-value memory. Supports legacy string values and metadata objects. |
| `log.jsonl` | Tool call log. Each line is a JSON object. Trimmed to the newest 1000 entries by `logToolCall`. |
| `audit.jsonl` | Dashboard audit events for mutating API actions. |
| `dashboard-errors.log` | Frontend or dashboard error reports. |
| `cron.json` | Sidekick-managed cron metadata. |
| `webhooks.json` | Stored webhook payloads received through dashboard API. |
| `context.json` | Structured project context, decisions, problems, patterns, sessions, and related data. |
| `procedures.json` | Learned procedures used by `sidekick_teach`. |
| `conversations/` | Agent task transcripts. Files older than 30 days are removed on Agent Bridge startup. |
| Additional tool files | Snapshots, queues, caches, baselines, circuits, runbooks, black-box captures, and other feature state may be stored by their matching tools. |

## KV schema

Legacy form:

```json
{
  "some_key": "some value"
}
```

Current metadata form:

```json
{
  "some_key": {
    "value": "some value",
    "project": "sidekick",
    "category": "config",
    "source": "mcp",
    "created": "2026-06-13T00:00:00.000Z",
    "updated": "2026-06-13T00:00:00.000Z"
  }
}
```

`sidekick_get` returns only the stored value for backward compatibility. `sidekick_get_by_project` returns key/value pairs for matching project metadata.

## KV migration

On load, `migrateKV` converts simple string entries to metadata objects. Some historical key prefixes are mapped to project names such as `system` or `proxmox_backup`. Existing object entries with a `value` field are preserved.

## Tool log schema

`logToolCall` writes JSONL entries with fields similar to:

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

Back up the entire data directory. The highest-value files are `kvstore.json`, `context.json`, `procedures.json`, `webhooks.json` if used, and `conversations/` if task transcripts matter. Logs and caches are usually lower value.
