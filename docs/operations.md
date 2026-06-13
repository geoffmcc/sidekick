# Operations

## Service commands

```bash
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
sudo systemctl restart sidekick-mcp
sudo systemctl restart sidekick-dashboard
sudo systemctl restart sidekick-agent
```

Logs:

```bash
sudo journalctl -u sidekick-mcp -n 100 --no-pager
sudo journalctl -u sidekick-dashboard -n 100 --no-pager
sudo journalctl -u sidekick-agent -n 100 --no-pager
```

Live logs:

```bash
sudo journalctl -u sidekick-mcp -f
```

## Health checks

MCP server:

```bash
curl http://127.0.0.1:4097/health
```

Agent Bridge:

```bash
curl http://127.0.0.1:4099/api/health
curl http://127.0.0.1:4099/api/agent/status
```

Dashboard:

```bash
curl http://127.0.0.1:4098/api/system
```

## Common problems

### `Missing key mcp.sidekick.enabled`

The opencode config needs an `enabled` property for the MCP entry. Use the current expected shape for your opencode version and include `enabled: true`.

### `Cannot find module express`

Dependencies were not installed in the project directory. Run:

```bash
cd /home/sidekick/sidekick
npm install --omit=dev
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

### Dashboard loads but API calls fail

Check whether dashboard Basic Auth is enabled, whether the browser request is hitting the right host/port, and whether origin checks are rejecting mutating requests. Check `dashboard-errors.log` and `audit.jsonl` in the data directory.

### MCP stale or invalid session

The MCP server intentionally rejects GET/DELETE without a valid `mcp-session-id`. For stale POST sessions, it returns a JSON-RPC error with a new session ID header. Reinitialize the MCP client session.

### Agent tasks do not progress

Check Agent Bridge logs, `SIDEKICK_MAX_ITERATIONS`, LLM provider availability, and whether the agent can call tools. If using Groq, verify `GROQ_API_KEY`. If using Ollama, verify the model service is reachable at `OLLAMA_URL`.

## Backups

Back up `SIDEKICK_DATA_DIR`. A simple backup:

```bash
tar -czf sidekick-data-$(date +%F).tar.gz -C /home/sidekick/sidekick data
```

For systemd deployments, also back up `.env`, but store it securely because it may contain API keys.

## Updates

Typical update flow:

```bash
cd /home/sidekick/sidekick
git pull
npm install --omit=dev
sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
```

If you use the deployment scripts, redeploy from your workstation instead.
