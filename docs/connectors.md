# Connectors

The **connector authority** is Sidekick's single governed path for external
integrations (starting with GitHub). It owns integration configuration,
credential references, lifecycle state, health, and observability, so an
integration is not a tool reaching an API directly with an ambient token.

## Authority

- **Registry:** `platform_connectors` (migration 031). Columns include
  `connector_id`, `name`, `type`, `state`, `endpoint`, `secret_ref`,
  `capabilities`, `config`, `health`, and lifecycle timestamps.
- **Kernel API** (`src/platform/kernel.js`): `registerConnector`,
  `getConnector`, `listConnectors`, `configureConnector`, `transitionConnector`,
  `recordConnectorHealth`, `listConnectorEvents`. Every change emits a
  `connector.*` platform event.
- **Lifecycle:** `registered → configured → enabled → healthy`, plus `error`,
  `disabled`, `retired` (transitions are validated). A connector is "live" for
  callers when `enabled` or `healthy`.
- **Credentials are references, never values.** `secret_ref` is an opaque
  `secret:<name>` pointer into Sidekick's encrypted secret store (the same store
  the `secret` tool manages). `assertConnectorConfigSafe` rejects raw credential
  values in `config`. The reference is resolved to plaintext only at call time by
  `src/connectors/resolve.js`, and is never surfaced on a record, an API
  response, or the dashboard (consumers see only `has_secret_ref`).

## GitHub connector

On startup `src/connectors/bootstrap.js` idempotently registers a managed GitHub
connector when a GitHub credential is available (a `github_token` encrypted
secret or a protected `github_token`/`sidekick_github_token` file):

- `type: github`, `endpoint: https://api.github.com`,
  `secret_ref: secret:github_token`, capabilities `repo`/`pull_request`/
  `issue`/`ci_status`, transitioned to `enabled`.
- Tagged `metadata.managed = "connector-bootstrap"` and matched by type, so
  re-running never duplicates it and operator edits survive.
- Set `SIDEKICK_DISABLE_CONNECTOR_BOOTSTRAP=1` to manage connectors by hand.

The `github` and `ci_status` tools (`src/tools/families/github.js`) resolve their
endpoint and token through the connector authority. Precedence:

1. The registered GitHub connector's `secret_ref` (resolved via the secret
   store) and its `endpoint`.
2. Protected file-backed GitHub credentials.
3. The legacy `github_token` secret-store key and the public API base.

This means the tool works before/without a connector, and pointing the connector
at a GitHub Enterprise `endpoint` (or rotating the underlying secret) governs the
integration without code changes.

## Operator visibility

The read-only `connector` tool inspects the authority:

```text
connector action="list" [type="github"] [state="enabled"]
connector action="get" connector_id="connector_..."
connector action="events" connector_id="connector_..."   # recent lifecycle events
```

It never exposes `secret_ref` — only `has_secret_ref`. Registration,
configuration, enable/disable remain on the governed dashboard + kernel path (a
mutating connector tool is a deliberate future step).

## Not yet (fast-follow)

Active connector health checks wired to `recordConnectorHealth`, per-call
observability events, approval/policy integration on connector mutation, a
dashboard connector surface, and migrating additional integrations (beyond
GitHub) onto the authority.
