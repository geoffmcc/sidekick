# Configuration

Sidekick uses a `.env` file for runtime configuration.

Start from the example file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` before deploying.

## Server Path

Use this path for server-side examples:

```bash
/home/sidekick/sidekick
```

Example:

```bash
cd /home/sidekick/sidekick
nano .env
```

## Remote IP Placeholder

Use this placeholder consistently:

```text
YOUR_REMOTE_IP
```

## Ollama Model

Recommended default:

```env
OLLAMA_MODEL=qwen2.5-coder:7b
```

This matches `.env.example` and is tuned for code-oriented work. CPU-only hosts may choose a smaller model; stronger hosts may choose a larger model.

## Providers (Ollama, Groq, OpenAI)

Model inference is routed by **Compute**. On startup Sidekick registers managed
providers from the environment (see `docs/compute.md` → *Providers and
credentials*):

- `OLLAMA_URL` (default `http://127.0.0.1:11434`) → local Ollama, trusted for all
  data classifications, preferred over cloud.
- `GROQ_API_KEY` (+ optional `GROQ_MODEL`) → Groq as an OpenAI-compatible cloud
  provider.
- `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`, `OPENAI_MODEL`,
  `OPENAI_EMBEDDING_MODEL`) → OpenAI-compatible cloud provider.

Cloud providers are seeded **secure by default**: they serve `public`/`internal`
data only and rank below local, so private inference stays local and fails closed
rather than silently egressing to the cloud. Promote a cloud provider to private
data explicitly via the `compute` tool (`action=update`, `data_classifications`).

When `SIDEKICK_SECRET_KEY` is set, a cloud provider's API key is migrated into the
encrypted secret store and the provider record keeps only a reference (never the
plaintext). Set `SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP=1` to manage providers by
hand.

## Platform event delivery

The event delivery drainer consumes the platform event ledger in the MCP
process (see `docs/platform-events.md`). Defaults are sensible; these exist for
tuning and for turning it off.

- `SIDEKICK_EVENT_DRAIN_INTERVAL_MS` (default `15000`, clamped 1s–5min) — how
  often pending deliveries are claimed.
- `SIDEKICK_EVENT_DRAIN_BATCH` (default `50`, clamped 1–500) — deliveries per
  pass.
- `SIDEKICK_EVENT_BACKLOG_CAP` (default `10000`, floor 10) — undelivered depth
  at which a subscription is **auto-paused** instead of accumulating without
  bound. A paused subscription records `auto_pause_reason`; drain or requeue its
  backlog, then resume it from the dashboard.
- `SIDEKICK_DISABLE_EVENT_DRAINER=1` — start with no drainer. Deliveries then
  queue up (bounded by the cap) until a drainer runs.

## Security and tool policy

Set a strong MCP API key before any non-local deployment:

```env
SIDEKICK_API_KEY=replace-with-a-long-random-value
```

For production, use a root-owned secret directory rather than putting
credential values in `.env`:

```env
SIDEKICK_SECRET_DIR=/etc/sidekick/secrets
```

Place these files there: `sidekick_api_key`, `sidekick_dashboard_pass`,
`sidekick_grafana_admin_password`, `sidekick_influx_token`,
`sidekick_influx_password`, `sidekick_postgres_password`, and
`sidekick_secret_key`. The loader rejects missing, non-regular, oversized,
symlinked, or group/world-writable files. Explicit `<SECRET_NAME>_FILE` paths
are also supported. Environment values remain a local-development
compatibility fallback; a configured file always takes precedence and
failures do not fall back to an environment value.

The bundled PostgreSQL, InfluxDB, and Grafana Compose services consume Docker
Secrets from this directory. Compose fails closed if `SIDEKICK_SECRET_DIR` or
any required service secret is missing. Grafana receives the Influx token only
inside its startup process so it can resolve the provisioned datasource; the
token is not present in Compose's service environment configuration.

Set dashboard credentials if the dashboard is reachable from a browser:

```env
SIDEKICK_DASHBOARD_USER=admin
SIDEKICK_DASHBOARD_PASS=replace-with-a-long-random-value
```

Use IP allowlists when practical:

```env
SIDEKICK_ALLOWED_IPS=192.168.1.0/24
SIDEKICK_DASHBOARD_ALLOWED_IPS=192.168.1.0/24
```

Tool policy defaults to `open` for backward compatibility. Use `restricted` for shared or public-facing deployments:

```env
SIDEKICK_TOOL_POLICY=restricted
SIDEKICK_AGENT_ALLOWED_TOOLS=read,search,get,respond
SIDEKICK_BLOCKED_TOOLS=db_restore,evolve
```

Policy lists accept exact tool names and risk selectors such as `risk:high` or `risk:critical`. Source-specific variables are available for `MCP`, `DASHBOARD`, and `AGENT` sources, for example `SIDEKICK_AGENT_TOOL_POLICY` and `SIDEKICK_MCP_BLOCKED_TOOLS`.

Inspect the effective policy before changing lockdown settings:

```javascript
tools({ action: "policy", source: "mcp,dashboard,agent", name: "bash", format: "json" })
```

The policy inspector reports whether each source/tool decision is allowed or blocked, the active mode, the matching allow/block selector when one applies, and whether approval is required.

Filesystem path guardrails default to open when unset. Set allowed paths to constrain direct file tools to specific directories, and denied paths to block sensitive locations. A path entry matches itself and its descendants; denied paths win over allowed paths.

```env
SIDEKICK_ALLOWED_PATHS=/home/sidekick/sidekick,/home/sidekick/projects
SIDEKICK_DENIED_PATHS=/home/sidekick/.ssh,/etc
SIDEKICK_AGENT_ALLOWED_PATHS=/home/sidekick/projects
```

The path guard applies to direct file and repo path arguments such as read, write, list, search, archive, hash, summarize, filter, find, extract, diff files, database backup/export/restore paths, media file inputs/outputs, file watches, snapshots, changelog repo paths, and ops repo paths. It does not parse arbitrary shell commands; keep high-power command tools gated with tool policy and approval.

Approval mode defaults to `off`, so allowed tools execute immediately. Use it when you want allowed high-risk actions to wait in the dashboard Approvals tab:

```env
SIDEKICK_SECRET_KEY=replace-with-a-strong-random-secret
SIDEKICK_APPROVAL_MODE=risky
SIDEKICK_APPROVAL_TTL_SECONDS=3600
SIDEKICK_APPROVAL_REQUIRED_TOOLS=evolve,db_restore
SIDEKICK_APPROVAL_EXEMPT_TOOLS=bash
SIDEKICK_AGENT_APPROVAL_MODE=strict
```

Approval variables support the same source prefixes as tool policy: `SIDEKICK_MCP_APPROVAL_MODE`, `SIDEKICK_DASHBOARD_APPROVAL_REQUIRED_TOOLS`, `SIDEKICK_AGENT_APPROVAL_EXEMPT_TOOLS`, and related required/exempt lists.
Queued arguments are encrypted with `SIDEKICK_SECRET_KEY`, removed after approval, rejection, failure, or expiry, and never returned by the approval-list API. Pending approvals expire after `SIDEKICK_APPROVAL_TTL_SECONDS` (default: `3600`). If the secret key is missing, Sidekick refuses to queue the action instead of storing its arguments in plaintext.

### Approval continuation (Brain tasks)

When Brain is enabled, an approval raised by a task is durably checkpointed so the task resumes after a decision (`docs/adr-approval-continuation.md`). Two background jobs run in the agent service and are **liveness dependencies**, not conveniences — if either stops, parked tasks stall:

```env
SIDEKICK_APPROVAL_SWEEP_INTERVAL_MS=60000    # expiry / orphan / deadline sweep
SIDEKICK_BRAIN_RESUME_INTERVAL_MS=5000       # task runner poll for runnable tasks
SIDEKICK_CHECKPOINT_LEASE_SECONDS=300        # claim lease (falls back to SIDEKICK_APPROVAL_LEASE_SECONDS)
SIDEKICK_APPROVAL_MAX_ATTEMPTS=5             # per-action reclaim ceiling
```

The sweep interval is an upper bound on how long a task can wait past its approval's expiry, so treat it as a correctness parameter rather than a tuning knob, and monitor the structured counts each sweep logs. Values are clamped: the sweep to 5s-15min, the resume poll to 1s-5min, and the lease to 30s-3600s.

Two constraints are easy to trip over:

- **Both jobs are gated on `SIDEKICK_BRAIN_ENABLED`.** Turning Brain off stops the sweeper and the resume scheduler, so any task parked while it was on stops being swept and will wait for nothing. Drain parked tasks before disabling Brain.
- **The reconciliation identity check rejects a set of automated-actor names**, including `sidekick`, `root`, `service`, `automation`, `dashboard`, `agent`, and `mcp`. `SIDEKICK_DASHBOARD_USER` is recorded verbatim as the acting principal, so setting it to one of those names makes reconciliation impossible for that deployment (it returns `reconciliation_requires_authorized_human`). Use a name that identifies a person.

`SIDEKICK_SECRET_KEY` is required to **resume** a parked task, not merely to queue one: checkpoints are encrypted at rest. Rotating the key strands parked tasks, so drain or explicitly fail them before rotation.

## Evolve Workflow Learning

`evolve` stores candidates, generated capabilities, validation results, usefulness counters, and generated-tool audit history in SQLite. Cleanup no longer deletes approved/rejected evidence by default because audit history is needed to explain why a capability exists or was deprecated.

Use lifecycle actions instead of deleting records:

```javascript
evolve({ action: "analyze" })
evolve({ action: "validate", id: "cand_..." })
evolve({ action: "approve", id: "cand_...", approver: "operator" })
evolve({ action: "promote", id: "cand_..." })
evolve({ action: "deprecate", id: "cand_...", reason: "unused" })
```

Trial and active generated tools are discoverable as `generated_<name>` after registry sync and MCP server startup (the older `sidekick_generated_<name>` alias form also resolves). Deprecated or rejected generated tools are removed from discovery but retain audit history.

## Automatic Memory

Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with compatibility copies in the `context` document:

```env
SIDEKICK_AUTO_MEMORY=1
SIDEKICK_AUTO_MEMORY_MAX=500
SIDEKICK_EMBEDDINGS=1
SIDEKICK_EMBEDDING_MODEL=nomic-embed-text
```

Set `SIDEKICK_AUTO_MEMORY=0` to disable automatic memory. Increase or decrease `SIDEKICK_AUTO_MEMORY_MAX` to control how many automatic memory entries are retained. Set `SIDEKICK_EMBEDDINGS=0` to disable semantic memory embeddings; otherwise Sidekick uses Ollama and Qdrant when available.

`SIDEKICK_QDRANT_URL` selects the Qdrant endpoint for semantic memory embeddings. The embedding service uses `OLLAMA_URL` and `OLLAMA_MODEL`.

`SIDEKICK_ALLOW_PRIVATE_FETCH=true` permits `web_fetch` to reach loopback and private-network destinations. Metadata and link-local destinations remain blocked.

Memory storage has three lifecycle surfaces:

- KV entries are key-value records. Use `delete` to remove a KV key.
- `context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recalled with `context action="recall" query="<id>"`.
- Structured memories live in the `memories` table. Use `memory_manage` for lifecycle actions. `delete`, `disable`, `expire`, and `restore` also work for legacy context IDs such as `sess_...`; confirmation and auto-expiration actions are structured-memory-only and return a clear unsupported-ID error for legacy context entries.

Project handoffs use the `resume` document. Use `resume action="check" project="<project>"` to resume pending work, `set` to leave a handoff, `clear` after completion, and `list` to audit active handoffs.

## Useful Checks

Check the configured Ollama model:

```bash
grep "^OLLAMA_MODEL=" .env
```

Check installed Ollama models:

```bash
ollama list
```

Check currently loaded/running Ollama models:

```bash
ollama ps
```

Inspect a model:

```bash
ollama show qwen2.5-coder:7b
```
