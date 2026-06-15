# Project Review

This review focuses on changes that improve project safety, user trust, and operator ergonomics without changing Sidekick's core model: a self-hosted MCP server, dashboard, and local agent with powerful host tools.

## Fixed in this branch

- Dashboard Basic Auth now protects the HTML app shell and agent event stream endpoints, not just most API routes.
- Dashboard Basic Auth and MCP bearer-token comparisons use constant-time comparison.
- Dashboard CSRF origin checks now compare exact hosts instead of substring matching.
- MCP bearer-token parsing now requires a valid `Bearer` authorization scheme.
- Dashboard and MCP database query paths now share the stricter read-only SQL helper.
- Read-only SQL rejects multi-statement input and mutating PRAGMA statements, requires row-returning statements, and clamps row limits.
- Database table and index helper queries quote identifiers instead of interpolating raw names.
- `sidekick_bash` dangerous-command checks now catch common case and flag-order variants for destructive recursive removal, destructive `dd`, and `curl|wget | sudo bash`.
- Security docs now describe dashboard auth coverage, database query safety, and the stronger command guardrails.
- A config-driven tool permission policy now supports global and source-specific allow/block lists.
- All exported tools now have risk classifications exposed through dashboard tool metadata.

## Highest-priority follow-ups

1. Add filesystem scope controls.
   `sidekick_read`, `sidekick_write`, archive, backup/export, sandbox, and diff tools currently operate on arbitrary paths. Keep the current power available for trusted single-user installs, but add `SIDEKICK_ALLOWED_PATHS` and `SIDEKICK_DENIED_PATHS` so users can restrict routine operation to project and data directories.

2. Add dashboard approval for risky scheduled actions.
   `sidekick_cron`, `sidekick_delay`, and `sidekick_watch` can persist tool execution beyond the current user session. The new policy can block these tools; the next step is an approval queue for selected high-risk scheduled actions.

3. Split tools by capability tier in user-facing docs.
   Keep all tools available internally, but expose user-facing groups such as `core`, `ops`, `data`, `security`, `experimental`, and `dangerous`. This makes onboarding clearer and lets clients select only the tier they need.

4. Add audit context for high-risk calls.
   Tool logs should include source, authenticated principal when known, request IP, and a risk class. Redacted arguments are already logged; this would make incident review much easier.

## Tool recommendations

Keep:

- The token-efficiency tools (`summarize`, `filter`, `find`, `extract`, `project`, `batch`, `cache`) are valuable and should stay.
- The DB tools are useful now that read-only behavior is stricter.
- `sidekick_debug_tool` is worth keeping because it prevents repeated investigation work.

Gate by policy rather than deleting:

- `sidekick_bash`, `sidekick_write`, `sidekick_db_restore`, `sidekick_runbook`, `sidekick_sandbox`, `sidekick_evolve`, `sidekick_cron`, `sidekick_delay`, and `sidekick_watch`.
- These are useful for trusted operators but too powerful to expose uniformly in every deployment mode.

Consider adding:

- `sidekick_policy` to inspect and test the active tool permission policy.
- `sidekick_fs_guard` or a shared path guard used by file-capable tools.
- `sidekick_approval_queue` for queued high-risk actions that require dashboard approval.
- `sidekick_secret_scan` to scan logs, KV entries, and exported artifacts for unredacted secrets.
- `sidekick_config_lint` to flag unsafe deployment settings such as default API keys, missing dashboard auth on non-local listeners, broad allowlists, or unrestricted dangerous tools.

## Product direction

The project description should be sharpened from "MCP server, dashboard, and local AI agent" to something closer to:

> Sidekick is a self-hosted remote operations agent. It exposes a secure MCP tool server, a web dashboard, and an autonomous local agent for managing a trusted machine, with persistent context, audit logs, and operational tools for files, services, databases, scheduling, diagnostics, and incident response.

That framing makes the security model clearer: Sidekick is not a generic chatbot. It is remote administrative capability with an AI interface.
