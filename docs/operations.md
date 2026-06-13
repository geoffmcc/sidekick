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

## Incident Response

When something goes wrong, use `sidekick_black_box` to capture a complete system snapshot in one call:

```json
{
  "action": "capture",
  "name": "incident-2026-06-13",
  "include": ["all"]
}
```

This captures:
- Service status (systemctl)
- Top processes (ps aux)
- Recent logs (journalctl, log.jsonl)
- Disk usage (df -h)
- Network listeners (ss -tlnp)

Rate limits: 5 captures per day, 7-day TTL, maximum 3 active incidents.

To retrieve a captured incident:

```json
{
  "action": "get",
  "incident_id": "bb_abc123"
}
```

## Operational Procedures

Use `sidekick_runbook` to define and execute operational procedures with verification and rollback:

```json
{
  "action": "create",
  "name": "deploy-service",
  "mode": "autonomous",
  "steps": [
    {
      "name": "Stop service",
      "command": "sudo systemctl stop myapp",
      "rollback": "sudo systemctl start myapp"
    },
    {
      "name": "Deploy new version",
      "command": "cd /opt/myapp && git pull && npm install",
      "rollback": "cd /opt/myapp && git checkout HEAD~1 && npm install"
    },
    {
      "name": "Start service",
      "command": "sudo systemctl start myapp",
      "verify_command": "curl -f http://localhost:3000/health"
    }
  ]
}
```

Execute autonomously:

```json
{
  "action": "start",
  "name": "deploy-service",
  "mode": "autonomous"
}
```

Or execute step-by-step in guided mode:

```json
{
  "action": "start",
  "name": "deploy-service",
  "mode": "guided"
}
```

Then advance with `action: "next"` and verify with `action: "verify"`.

## Network Troubleshooting

Use `sidekick_netdiag` for unified network diagnostics instead of running multiple commands:

```json
{
  "action": "check",
  "target": "https://api.example.com"
}
```

This checks:
- DNS resolution
- Ping connectivity
- HTTP response (status, time, SSL)
- SSH port availability

Other actions:
- `dns` — DNS resolution chain
- `route` — Traceroute to target
- `ports` — Scan specific ports or common ports
- `listeners` — Show local listening ports
- `connectivity` — Quick up/down check for multiple targets

## Anomaly Detection

Use `sidekick_baseline` to learn normal behavior patterns and detect anomalies:

Record data points:

```json
{
  "action": "record",
  "metric_name": "cpu_usage",
  "value": 25
}
```

After collecting sufficient data (minimum 10 points), learn the baseline:

```json
{
  "action": "learn",
  "metric_name": "cpu_usage"
}
```

Check for anomalies:

```json
{
  "action": "check",
  "metric_name": "cpu_usage",
  "value": 45,
  "sensitivity": "medium"
}
```

The baseline uses time-of-day bucketing (4-hour windows) and statistical analysis (mean ± standard deviation) to detect deviations from normal patterns.
