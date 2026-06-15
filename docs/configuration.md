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
OLLAMA_MODEL=phi3:3.8b
```

This model was chosen because the reference server does not have GPU access, so it needs a small model that can run reasonably on CPU-only hardware.

Users with a stronger CPU, more RAM, or GPU acceleration may want to use a larger or more capable Ollama model instead.

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
ollama show phi3:3.8b
```
