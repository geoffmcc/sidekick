# Security

Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.

## MCP authentication

The MCP server requires an API key. Clients can send it as:

```http
Authorization: Bearer YOUR_SIDEKICK_API_KEY
```

or as an `api_key` query parameter. Use the header form whenever possible.

The default development value is `sk-sidekick-local-dev`. Change it before any non-local deployment.

## IP allowlists

`SIDEKICK_ALLOWED_IPS` restricts MCP access by IPv4 address or CIDR range. Localhost is always allowed. `SIDEKICK_DASHBOARD_ALLOWED_IPS` provides similar filtering for the dashboard.

IP allowlists are useful but should not be the only protection if the service is public. Prefer VPN, SSH tunnel, reverse proxy auth, and firewall rules.

## Dashboard authentication

Set both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` to enable Basic Auth for dashboard API routes. For public exposure, Basic Auth alone is not ideal; combine it with TLS and network restrictions.

## Dashboard protections

The dashboard includes:

- in-memory rate limiting per IP;
- basic origin checks for mutating requests;
- audit logging of mutating actions;
- frontend error logging;
- optional Basic Auth;
- optional IP allowlist.

## Command safety

`sidekick_bash` blocks commands matching known dangerous patterns, including examples such as recursive root deletion, block-device writes, filesystem creation, fork-bomb pattern, curl/wget piped to shell, and recursive `chmod 777 /`.

This is a guardrail, not a full sandbox. It will not detect every destructive command. Avoid granting Sidekick broader sudo access than necessary.

## Sudoers scope

The supplied sudoers file allows the `sidekick` user to run specific systemctl and journalctl commands for the three Sidekick services, plus selected UFW allow commands. Keep this file narrow. Do not give blanket passwordless sudo unless you intentionally want the assistant to have full root-level control.

## Redaction

`src/redact.js` redacts sensitive output patterns before data is returned or logged. The tests cover private keys, GitHub tokens, and other secret-like values. Redaction reduces accidental leakage but cannot guarantee every secret in every format is removed.

## Secret storage

`sidekick_secret` provides AES-256-GCM encrypted credential management and requires `SIDEKICK_SECRET_KEY`. Store the secret key outside the repository and include it in your host secret management or systemd environment strategy.

## Exposure recommendations

Recommended safest setup:

1. Bind services to a private interface or firewall them to VPN-only access.
2. Use a strong `SIDEKICK_API_KEY`.
3. Enable dashboard auth if dashboard is reachable by browser clients.
4. Keep the Agent Bridge private; access it through the dashboard proxy only.
5. Use HTTPS if crossing an untrusted network.
6. Back up the data directory but protect backups because they can contain sensitive operational history.
