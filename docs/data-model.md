# Data Model and Persistent Storage

Sidekick stores operational state under `SIDEKICK_DATA_DIR`. By default this is the repository `data` directory.

## Storage Files

| Path | Owner | Purpose |
|---|---|---|
| `kvstore.json` | tools, dashboard | Persistent key-value storage with project/source/timestamp metadata. |
| `log.jsonl` | tools | Append-only tool call log, capped to the most recent 1000 entries. |
| `cron.json` | `sidekick_cron` | Recurring task definitions that are synced to crontab. |
| `webhooks.json` | dashboard, `sidekick_webhook` | Stored webhook payloads. |
| `context.json` | `sidekick_context`, `sidekick_predict` | Projects, decisions, problems, patterns, and sessions. |
| `procedures.json` | `sidekick_teach`, MCP startup | Learned procedures and dynamic tool definitions. |
| `health_history.json` | `sidekick_health` | Historical health scores. |
| `delays.json` | `sidekick_delay`, agent bridge | One-shot scheduled tool calls. |
| `snapshots/` | `sidekick_snapshot` | Captured system state snapshots. |
| `watches.json` | `sidekick_watch`, agent bridge | Active and paused monitoring rules. |
| `secrets.enc` | `sidekick_secret` | Encrypted credential store. |
| `queue.json` | `sidekick_queue` | Persistent task queue. |
| `evolve.json` | `sidekick_evolve` | Proposed system improvements and analysis metadata. |
| `orchestrate.json` | `sidekick_orchestrate` | Multi-step task graph records. |
| `predict.json` | `sidekick_predict` | Predictions and prediction feedback. |
| `conversations/*.json` | agent bridge | Saved autonomous agent task transcripts. |
| `audit.jsonl` | dashboard | State-changing dashboard operation audit log. |
| `dashboard-errors.log` | dashboard | Frontend/API error log. |

## KV Store Format

The current KV format stores metadata with every value:

```json
{
  "example:key": {
    "value": "stored value",
    "project": "system",
    "source": "mcp",
    "created": "2026-06-11T00:00:00.000Z",
    "updated": "2026-06-11T00:00:00.000Z"
  }
}
```

The migration code accepts legacy entries where a key maps directly to a string. During startup, strings are converted to metadata objects. Some key prefixes are automatically assigned to project `system`, and selected legacy keys are assigned to project `proxmox_backup`.

## Tool Call Log Format

`log.jsonl` stores one JSON object per line:

```json
{
  "t": "ISO timestamp",
  "n": "tool name",
  "a": "formatted arguments",
  "d": 42,
  "ok": true,
  "s": "summary",
  "src": "mcp"
}
```

Arguments and summaries are redacted before they are logged. The log is trimmed to the newest 1000 lines.

## Conversation Transcript Format

Agent transcripts are stored as JSON files named by task ID. The object includes:

- `goal`: original task goal.
- `steps`: thoughts, tool calls, results, errors, and done events.
- `status`: currently written as `completed` by the bridge.
- `t`: timestamp.

At agent startup, transcripts older than 30 days are deleted.

## Secret Store

`secrets.enc` is written by `sidekick_secret`. The implementation uses AES-256-GCM and derives the encryption key from `SIDEKICK_SECRET_KEY`. Secret listing returns secret names rather than decrypted values.

## Backup Guidance

For backups, include the entire `SIDEKICK_DATA_DIR`. At minimum, preserve:

- `kvstore.json`
- `context.json`
- `procedures.json`
- `secrets.enc` plus the external `SIDEKICK_SECRET_KEY`
- `cron.json`
- `watches.json`
- `delays.json`
- `snapshots/`

Without `SIDEKICK_SECRET_KEY`, encrypted secrets cannot be recovered from `secrets.enc`.
