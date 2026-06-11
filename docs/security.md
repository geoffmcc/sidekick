# Security

Sidekick provides powerful remote execution capabilities. Treat any exposed Sidekick endpoint as privileged infrastructure.

## MCP Authentication

The MCP server requires an API key for all routes after `/health`. The key is accepted as either:

```text
Authorization: Bearer <SIDEKICK_API_KEY>
```

or:

```text
?api_key=<SIDEKICK_API_KEY>
```

The default key is `sk-sidekick-local-dev`. Change it before any network exposure.

## MCP IP Allowlist

Set `SIDEKICK_ALLOWED_IPS` to a comma-separated list of trusted addresses. Loopback addresses are always allowed. If unset, the MCP server does not enforce an IP allowlist.

## Dashboard Protections

The dashboard includes:

- Optional IP allowlist via `SIDEKICK_DASHBOARD_ALLOWED_IPS`.
- In-memory rate limiting: 200 requests per 15 minutes per IP.
- JSON body limit of 1 MB.
- Content-Length rejection above 1 MB.
- Origin checks for POST, PUT, DELETE, and PATCH requests.
- Optional HTTP Basic auth through `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS`.
- Audit logging for state-changing operations.

Important note: the dashboard permits `/api/agent/stream/:taskId` without Basic auth so Server-Sent Events can work. Use firewall rules, a reverse proxy, VPN access, or an IP allowlist to protect the dashboard.

## Agent Bridge Exposure

The agent bridge listens on `127.0.0.1`, which is the correct default posture. It can execute Sidekick tools autonomously, so it should not be exposed directly to the public internet.

## Command Safety

`sidekick_bash` blocks several destructive patterns before command execution, including:

- `rm -rf /`
- direct writes to common block devices
- `mkfs`, `fdisk`, `parted`, and `dd if=`
- fork bomb pattern
- `curl` or `wget` piped to `bash` or `sh`
- recursive `chmod 777 /`

This is a safeguard, not a sandbox. Many dangerous commands will not match those patterns. Use OS-level permissions, a restricted user, backups, and network controls.

## Redaction

`src/redact.js` redacts common secret patterns, including:

- SSH private keys.
- GitHub classic and fine-grained tokens.
- OpenAI-style `sk-` keys.
- AWS access keys and secret variables.
- Generic password, secret, token, and API key assignments.
- Bearer tokens.
- Database connection-string passwords.
- Stripe live keys.
- JWTs.

Redaction is applied in many tool outputs and logs, but it should not be treated as a complete data-loss prevention system.

## Secret Storage

`sidekick_secret` encrypts stored credentials with AES-256-GCM. It requires `SIDEKICK_SECRET_KEY`; without that variable, secret operations fail. The encrypted store is `secrets.enc`.

The GitHub integration currently reads `github_token` from KV storage, not from the encrypted secret store. If using GitHub automation, consider the exposure implications of storing that token in KV.

## Recommended Hardening

- Change `SIDEKICK_API_KEY` immediately.
- Keep the agent bridge on loopback.
- Restrict ports 4097 and 4098 with a firewall, VPN, or reverse proxy ACL.
- Enable dashboard Basic auth.
- Use both MCP and dashboard IP allowlists where possible.
- Run Sidekick as an unprivileged user.
- Limit sudoers rules to specific required systemctl and journalctl commands.
- Back up `SIDEKICK_DATA_DIR` before enabling automated operations.
- Avoid using `sidekick_bash` for actions that have safer specialized tools.
