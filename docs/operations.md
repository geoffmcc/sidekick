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

Normal online deployment is Git based. `/home/sidekick/sidekick` should be a clone of `https://github.com/geoffmcc/sidekick.git` on branch `main`, with the push URL disabled:

```bash
git remote get-url origin
git remote get-url --push origin
```

The fetch URL must be the public read-only repository URL and the push URL must be `DISABLED`. This is defense in depth against accidental pushes from the deployment host. It does not prevent deliberate misuse by a shell process that separately has write-capable GitHub credentials.

Use the deployment scripts from the workstation for first-time conversion or normal deploy:

```powershell
.\deploy.ps1 -IP "YOUR_REMOTE_IP"
```

```bash
./deploy.sh -IP YOUR_REMOTE_IP
```

The first conversion from a non-Git deployment uses a deployment lock, clones into staging, installs production dependencies, stops Sidekick services before the final state backup, stores backups under `/home/sidekick/backups/deploy-<UTC timestamp>/`, moves the previous app directory to `/home/sidekick/sidekick.rollback-<UTC timestamp>`, restores `.env` and `data/`, disables Git push, restarts services, and keeps both backup and rollback directories for operator-controlled cleanup.

Rollback after conversion:

```bash
sudo systemctl stop sidekick-mcp sidekick-dashboard sidekick-agent
mv /home/sidekick/sidekick /home/sidekick/sidekick.failed-$(date -u +%Y%m%dT%H%M%SZ)
mv /home/sidekick/sidekick.rollback-<UTC timestamp> /home/sidekick/sidekick
sudo systemctl restart sidekick-agent sidekick-dashboard sidekick-mcp
```

SCP mode is retained only for explicit offline or air-gapped deployments:

```powershell
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -Scp
```

```bash
./deploy.sh -IP YOUR_REMOTE_IP --scp
```

SCP mode copies local files and does not create a Git working tree. Do not use it as the normal online path. `sidekick_ops deploy_current_main` requires a Git deployment and will not silently fall back to SCP.

## Packaged operations workflows

Use `sidekick_ops` when you need a compact verdict instead of separate raw tool outputs.

Available actions:

- `verify_deployed_commit`: confirms the fixed Sidekick host checkout at `/home/sidekick/sidekick` is a clean `main` checkout matching `origin/main`, verifies the read-only fetch URL and disabled push URL, and checks core service state.
- `restart_and_smoke_test`: restarts `sidekick-dashboard` and `sidekick-agent`, checks MCP health, and optionally schedules an MCP restart with `restart_mcp: true`.
- `deploy_current_main`: operates only on `/home/sidekick/sidekick`, deploys only `origin/main`, refuses dirty, staged, ahead, diverged, wrong-branch, wrong-origin, credentialed-origin, or push-enabled states, uses a deployment lock, fast-forwards only, installs production dependencies, runs knowledge seeding, restarts required services, and schedules MCP restart after the response.
- `incident_snapshot`: captures service state, resource status, git state, top processes, and recent service logs.

MCP self-restarts are scheduled after the response so callers can receive a verdict before the MCP transport reconnects.
