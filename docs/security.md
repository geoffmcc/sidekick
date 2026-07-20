# Security

Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.

## MCP authentication

The MCP server requires an API key. Clients can send it as:

```http
Authorization: Bearer YOUR_SIDEKICK_API_KEY
```

or as an `api_key` query parameter. Use the header form whenever possible.

Set `SIDEKICK_API_KEY` to a strong non-placeholder value before starting the MCP server or dashboard.

## IP allowlists

`SIDEKICK_ALLOWED_IPS` restricts MCP access by IPv4 address or CIDR range. Localhost is always allowed. `SIDEKICK_DASHBOARD_ALLOWED_IPS` provides similar filtering for the dashboard.

IP allowlists are useful but should not be the only protection if the service is public. Prefer VPN, SSH tunnel, reverse proxy auth, and firewall rules.

## Dashboard authentication

Set both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` to enable Basic Auth for the dashboard HTML, API routes, and agent event streams. Static assets remain public so authenticated browsers can load CSS and fonts. For public exposure, Basic Auth alone is not ideal; combine it with TLS and network restrictions.

## Dashboard protections

The dashboard includes:

- in-memory rate limiting per IP;
- basic origin checks for mutating requests;
- audit logging of mutating actions;
- frontend error logging;
- optional Basic Auth;
- optional IP allowlist.

## Command safety

`sidekick_bash` blocks commands matching known dangerous patterns, including examples such as recursive root deletion, common flag-order and case variants, block-device writes, filesystem creation, fork-bomb pattern, curl/wget piped to shell, and recursive `chmod 777 /`.

This is a guardrail, not a full sandbox. It will not detect every destructive command. Avoid granting Sidekick broader sudo access than necessary.

## Tool permission policy

Sidekick now supports a config-driven tool policy. The default `SIDEKICK_TOOL_POLICY=open` preserves existing behavior: tools are allowed unless explicitly blocked.

Set `SIDEKICK_TOOL_POLICY=restricted` to block high and critical risk tools unless they are explicitly allowed. You can also set source-specific policies for `mcp`, `dashboard`, and `agent`:

```env
SIDEKICK_AGENT_TOOL_POLICY=restricted
SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond
SIDEKICK_BLOCKED_TOOLS=sidekick_db_restore,sidekick_evolve
```

Policy lists accept tool names and risk selectors such as `risk:high` or `risk:critical`. Explicit blocklists win over allowlists.

High and critical tools are not removed from the project because trusted operators need them. For internet-reachable or shared deployments, run the agent and MCP source in `restricted` mode and allow only the tools required for the workflow.

Use the tool policy inspector to verify effective access before and after changing environment variables:

```javascript
sidekick_tools({ action: "policy", source: "mcp,dashboard,agent", name: "sidekick_bash", format: "json" })
```

It reports the policy decision, active mode, matching selector when applicable, and approval requirement for each inspected source/tool pair.

## Filesystem path guardrails

Filesystem path guardrails restrict direct file and repository path arguments while preserving open defaults for trusted single-user deployments. Leave these variables unset for current behavior, or set comma-separated absolute paths:

```env
SIDEKICK_ALLOWED_PATHS=/home/sidekick/sidekick,/home/sidekick/projects
SIDEKICK_DENIED_PATHS=/home/sidekick/.ssh,/etc
SIDEKICK_AGENT_ALLOWED_PATHS=/home/sidekick/projects
```

Allowed entries match the path itself and descendants. Denied entries take precedence over allowed entries. Source-specific variants are available for `MCP`, `DASHBOARD`, and `AGENT`, for example `SIDEKICK_AGENT_DENIED_PATHS`.

Paths are canonicalized before they are compared, so a symlink is judged by where it points rather than by where it sits: a link beneath an allowed root cannot reach a target outside it, and a path that resolves into a denied root is denied whichever route reaches it. Resolution follows the path component by component, so a `..` after a symlink applies to the link's target as the kernel applies it, rather than being collapsed away first. Configured roots are canonicalized the same way, so an allowed root that is itself a symlink keeps working. A target that does not exist yet is resolved through its nearest existing ancestor, which is enough to catch an escaping link in the part of the path that does exist. A dangling symlink, a symlink cycle, or a configured root that exists but cannot be resolved is refused rather than guessed past — note that a single unresolvable root denies every path, so a broken entry locks the guard shut rather than opening it.

Three limits are worth stating plainly. A hard link is not a symlink and has no separate target to resolve, so a hard link created inside an allowed root to a file outside it reads as an ordinary file in that root and is permitted; keep allowed roots on filesystems where untrusted users cannot create links to sensitive files. Comparison is case-sensitive, so on a case-insensitive filesystem — a `/mnt/c` DrvFS mount under WSL, for example — a differently-cased spelling of a denied root is not recognised; keep roots on a case-sensitive filesystem where this matters. And this is a check on the path, performed before the operation: it does not close the window between the check and the subsequent filesystem access, so a path that is replaced in that interval can still be followed.

The guard applies to direct path arguments on file, archive, search, diff, database export/backup/restore, media, watch, snapshot, changelog, and ops tools. It does not parse arbitrary commands passed to shell-capable tools, so keep `sidekick_bash`, sandbox execution, deploy workflows, and other high-power tools behind tool policy and approval.

## Approval queue

The approval queue is an optional dashboard review layer for allowed tools. It does not enable tools that policy blocks. The default `SIDEKICK_APPROVAL_MODE=off` preserves existing behavior.

Set `SIDEKICK_APPROVAL_MODE=risky` to queue critical-risk tools for dashboard approval, or `SIDEKICK_APPROVAL_MODE=strict` to queue high and critical tools. Approval lists accept exact tool names and risk selectors, and source-specific variables are available for `MCP`, `DASHBOARD`, and `AGENT` sources:

```env
SIDEKICK_SECRET_KEY=replace-with-a-strong-random-secret
SIDEKICK_APPROVAL_MODE=risky
SIDEKICK_APPROVAL_TTL_SECONDS=3600
SIDEKICK_APPROVAL_REQUIRED_TOOLS=sidekick_evolve,sidekick_db_restore
SIDEKICK_APPROVAL_EXEMPT_TOOLS=sidekick_bash
SIDEKICK_AGENT_APPROVAL_MODE=strict
```

Pending requests appear in the dashboard Approvals tab with structurally redacted argument previews. Full arguments are encrypted with `SIDEKICK_SECRET_KEY`, never returned by the approval-list API, and discarded after approval, rejection, failure, or expiry. Pending approvals expire after `SIDEKICK_APPROVAL_TTL_SECONDS` (default: one hour). If the secret key is missing, Sidekick refuses to queue the action instead of storing its arguments in plaintext.

Approving a request executes it under the original source and reuses current tool-policy enforcement while bypassing only the approval check. A tool blocked after it was queued therefore remains blocked at execution time.

## Database query safety

The database query tool and dashboard query endpoint default to read-only mode. In that mode they allow single-statement row-returning SQL only (`SELECT`, `WITH`, `EXPLAIN`, and non-mutating `PRAGMA`), reject multi-statement input, and apply bounded row limits. Use `readonly=false` only for deliberate maintenance.

## Sudoers scope

The supplied sudoers file allows the `sidekick` user to run specific systemctl and journalctl commands for the three Sidekick services, plus selected UFW allow commands. Keep this file narrow. Do not give blanket passwordless sudo unless you intentionally want the assistant to have full root-level control.

## Redaction

`src/redact.js` redacts sensitive output patterns before data is returned or logged. The tests cover private keys, GitHub tokens, and other secret-like values. Redaction reduces accidental leakage but cannot guarantee every secret in every format is removed.

## Secret storage

`sidekick_secret` provides AES-256-GCM encrypted credential management and requires `SIDEKICK_SECRET_KEY`. Store the secret key outside the repository and include it in your host secret management or systemd environment strategy. API tokens such as the GitHub PAT used by `sidekick_github` belong in `sidekick_secret` as encrypted secrets, not in KV memory.

## Configuration and secret scanning

Use `sidekick_security_scan` for a read-only audit before deployments or after configuration changes:

```javascript
sidekick_security_scan({ path: "/home/sidekick/sidekick", format: "text" })
```

The scanner checks for tracked sensitive files, private-key and high-confidence credential signatures, hardcoded sensitive configuration values or fallbacks, generated credential filenames, runtime `.env` security keys, and permissive sensitive-file modes. It reports paths, key names, line numbers, and severity only; it never returns matched values. Scans obey global and source-specific path policy, skip denied descendants, and are bounded by `max_files`.

Findings are audit results, not automatic mutations. Rotate exposed credentials, remove tracked secrets from history, replace hardcoded defaults with secret injection, and restrict file permissions through a deliberate remediation workflow.

## Exposure recommendations

Recommended safest setup:

1. Bind services to a private interface or firewall them to VPN-only access.
2. Use a strong `SIDEKICK_API_KEY`.
3. Enable dashboard auth if dashboard is reachable by browser clients.
4. Set `SIDEKICK_TOOL_POLICY=restricted` for shared or public-facing deployments.
5. Enable `SIDEKICK_APPROVAL_MODE=risky` or source-specific approval for autonomous/background actions.
6. Keep the Agent Bridge private; access it through the dashboard proxy only.
7. Use HTTPS if crossing an untrusted network.
7. Back up the data directory but protect backups because they can contain sensitive operational history.
