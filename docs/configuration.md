# Configuration

Sidekick is configured primarily through environment variables. `.env.example` documents the intended variables.

## Core Variables

| Variable | Default | Purpose |
|---|---|---|
| `SIDEKICK_API_KEY` | `sk-sidekick-local-dev` | Token required by the MCP server. Accepted as `Authorization: Bearer <token>` or `api_key` query parameter. |
| `SIDEKICK_ALLOWED_IPS` | empty | Comma-separated IP allowlist for the MCP server. Loopback is always allowed. |
| `SIDEKICK_PORT` | `4097` | MCP server port. |
| `SIDEKICK_DASHBOARD_PORT` | `4098` | Dashboard port. |
| `SIDEKICK_AGENT_PORT` | `4099` | Agent bridge port. |
| `SIDEKICK_DATA_DIR` | `data` under the repository | Persistent storage directory for logs, KV data, transcripts, snapshots, queues, and other state. |
| `SIDEKICK_MAX_ITERATIONS` | `15` | Maximum number of LLM loop iterations per autonomous agent task. |

## Dashboard Variables

| Variable | Default | Purpose |
|---|---|---|
| `SIDEKICK_DASHBOARD_USER` | empty | Dashboard HTTP Basic authentication username. If empty, dashboard auth is disabled. |
| `SIDEKICK_DASHBOARD_PASS` | empty | Dashboard HTTP Basic authentication password. If empty, dashboard auth is disabled. |
| `SIDEKICK_DASHBOARD_ALLOWED_IPS` | empty | Dashboard-specific comma-separated IP allowlist. Loopback is always allowed. |

## LLM Variables

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Intended local Ollama endpoint. The implemented local calls use `127.0.0.1:11434` directly. |
| `GROQ_API_KEY` | empty | When set, `sidekick_llm` and the agent bridge use Groq instead of local Ollama. |
| `GROQ_MODEL` | `llama-3.1-8b-instant` | Groq model name. |

## Notification Variables

Email notifications require SMTP variables:

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | SMTP host used by `sidekick_notify` for email channel. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` | empty | SMTP username and email sender. |
| `SMTP_PASS` | empty | SMTP password. |

Implementation note: the email path in `sidekick_notify` builds an email-like message, but uses `https.request()` rather than a standard SMTP client. Treat this as an area to test before relying on email delivery.

## Secret Storage Variable

| Variable | Default | Purpose |
|---|---|---|
| `SIDEKICK_SECRET_KEY` | none | Required by `sidekick_secret`. The key is hashed to derive the AES-256-GCM encryption key. |

## Recommended Production Settings

For any non-local deployment:

```bash
SIDEKICK_API_KEY=<long-random-token>
SIDEKICK_DASHBOARD_USER=<admin-user>
SIDEKICK_DASHBOARD_PASS=<long-random-password>
SIDEKICK_ALLOWED_IPS=<trusted-client-ip-list>
SIDEKICK_DASHBOARD_ALLOWED_IPS=<trusted-browser-ip-list>
SIDEKICK_SECRET_KEY=<long-random-secret>
SIDEKICK_DATA_DIR=/home/sidekick/sidekick/data
```

Use a firewall or reverse proxy to limit exposed ports. The agent bridge is already bound to loopback and should normally remain private.
