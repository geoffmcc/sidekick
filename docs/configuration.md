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

## Groq vs Ollama

If `GROQ_API_KEY` is configured, Sidekick can use Groq for faster cloud LLM responses.

If Groq is not configured, Sidekick can use local Ollama as a fallback.

## Security and tool policy

Set a strong MCP API key before any non-local deployment:

```env
SIDEKICK_API_KEY=replace-with-a-long-random-value
```

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
SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond
SIDEKICK_BLOCKED_TOOLS=sidekick_db_restore,sidekick_evolve
```

Policy lists accept exact tool names and risk selectors such as `risk:high` or `risk:critical`. Source-specific variables are available for `MCP`, `DASHBOARD`, and `AGENT` sources, for example `SIDEKICK_AGENT_TOOL_POLICY` and `SIDEKICK_MCP_BLOCKED_TOOLS`.

Inspect the effective policy before changing lockdown settings:

```javascript
sidekick_tools({ action: "policy", source: "mcp,dashboard,agent", name: "sidekick_bash", format: "json" })
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
SIDEKICK_APPROVAL_MODE=risky
SIDEKICK_APPROVAL_REQUIRED_TOOLS=sidekick_evolve,sidekick_db_restore
SIDEKICK_APPROVAL_EXEMPT_TOOLS=sidekick_bash
SIDEKICK_AGENT_APPROVAL_MODE=strict
```

Approval variables support the same source prefixes as tool policy: `SIDEKICK_MCP_APPROVAL_MODE`, `SIDEKICK_DASHBOARD_APPROVAL_REQUIRED_TOOLS`, `SIDEKICK_AGENT_APPROVAL_EXEMPT_TOOLS`, and related required/exempt lists.

## Evolve Tool Retention

The evolve tool automatically cleans up old proposals to prevent unbounded growth:

```env
SIDEKICK_EVOLVE_RETENTION_DAYS=30
```

**What gets cleaned up:**
- Rejected, test_failed, and rejected_low_confidence proposals older than retention period
- Non-pending queue entries older than retention period

**What's kept forever:**
- All approved proposals (valuable historical record)
- Recent proposals (< retention days)
- Pending queue entries

**Automatic cleanup triggers:**
- File size > 100KB, OR
- Total proposals > 50

**Manual cleanup:**
```javascript
// Preview what would be deleted
sidekick_evolve({ action: "cleanup" })

// Actually delete old entries
sidekick_evolve({ action: "cleanup", confirm: true })
```

## Automatic Memory

Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with compatibility copies in the `context` document:

```env
SIDEKICK_AUTO_MEMORY=1
SIDEKICK_AUTO_MEMORY_MAX=500
SIDEKICK_EMBEDDINGS=1
SIDEKICK_EMBEDDING_MODEL=nomic-embed-text
SIDEKICK_OLLAMA_URL=http://127.0.0.1:11434
```

Set `SIDEKICK_AUTO_MEMORY=0` to disable automatic memory. Increase or decrease `SIDEKICK_AUTO_MEMORY_MAX` to control how many automatic memory entries are retained. Set `SIDEKICK_EMBEDDINGS=0` to disable semantic memory embeddings; otherwise Sidekick uses Ollama and Qdrant when available.

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
