# Operations Guide

## Health Checks

MCP server:

```bash
curl http://127.0.0.1:4097/health
```

Agent bridge:

```bash
curl http://127.0.0.1:4099/api/health
```

Sidekick health tool:

```json
{
  "check": "all"
}
```

through `sidekick_health` produces a Markdown report with service, process, disk, and network sections.

## Service Management

If installed as systemd services, the likely service names are:

```text
sidekick-mcp
sidekick-dashboard
sidekick-agent
```

Common commands:

```bash
sudo systemctl status sidekick-mcp
sudo systemctl restart sidekick-mcp
sudo systemctl status sidekick-dashboard
sudo systemctl restart sidekick-dashboard
sudo systemctl status sidekick-agent
sudo systemctl restart sidekick-agent
```

Logs:

```bash
sudo journalctl -u sidekick-mcp -n 100 --no-pager
sudo journalctl -u sidekick-dashboard -n 100 --no-pager
sudo journalctl -u sidekick-agent -n 100 --no-pager
```

## Data Maintenance

The dashboard exposes destructive maintenance endpoints for logs, KV data, conversations, and combined data reset. Use them carefully.

Manual maintenance examples:

```bash
# Back up all Sidekick state
cp -a "$SIDEKICK_DATA_DIR" "$SIDEKICK_DATA_DIR.backup.$(date +%Y%m%d-%H%M%S)"

# Inspect recent tool logs
tail -n 50 "$SIDEKICK_DATA_DIR/log.jsonl"

# Validate JSON files
python3 -m json.tool "$SIDEKICK_DATA_DIR/kvstore.json" >/dev/null
python3 -m json.tool "$SIDEKICK_DATA_DIR/context.json" >/dev/null
```

## Restart Effects

Restarting the MCP server:

- Drops in-memory MCP sessions.
- Reloads built-in and learned procedure tools.
- Re-runs KV migration if needed.

Restarting the dashboard:

- Clears in-memory rate-limit counters.
- Seeds missing system KV keys again.

Restarting the agent bridge:

- Reloads pending delays.
- Reloads active watches.
- Deletes conversation transcripts older than 30 days.
- Clears in-memory task event emitters.

## Troubleshooting

### MCP client receives unauthorized errors

Check that the client sends the correct API key as a Bearer token or `api_key` query parameter. Confirm `SIDEKICK_API_KEY` is identical on client and server.

### MCP sessions fail after restart

Sessions are in memory. Reconnect and reinitialize the MCP client.

### Dashboard is inaccessible

Check:

- `SIDEKICK_DASHBOARD_PORT`.
- Dashboard process status.
- Firewall rules.
- `SIDEKICK_DASHBOARD_ALLOWED_IPS`.
- Basic auth credentials.
- Browser origin if state-changing requests fail.

### Agent task does not progress

Check:

- `GROQ_API_KEY`, if using Groq.
- Local Ollama availability on `127.0.0.1:11434`, if not using Groq.
- `SIDEKICK_MAX_ITERATIONS`.
- Agent bridge logs.
- Whether the bridge is reachable from the dashboard host on loopback.

### Delays or watches do not run

Delays and watches are scheduled by the agent bridge in memory. Verify `sidekick-agent` is running, then call:

```bash
curl -X POST http://127.0.0.1:4099/api/delays/reload
curl -X POST http://127.0.0.1:4099/api/watches/reload
```

### Learned procedure is not visible as a tool

Learned procedures are registered at MCP startup. Restart `sidekick-mcp` after teaching a new procedure.

### GitHub calls fail

The GitHub tool expects a KV entry named `github_token`. Verify it exists and that the token has the required repository permissions.
