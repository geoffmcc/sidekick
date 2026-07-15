# Black Box Incident Explorer

Black Box captures configured incident context and stores it as structured evidence. It is no longer only a raw text time capsule.

## Concepts

- Incident: durable troubleshooting record with lifecycle, severity, tags, retention, summaries, and links.
- Capture: one collection event for an incident. Incidents can have initial, follow-up, baseline, pre-remediation, and verification captures.
- Source: one collector result with command/tool metadata, timestamps, state, exit code, timeout/truncation/redaction flags, hashes, stdout/stderr artifacts, and normalized output.
- Observation: a direct structured fact extracted from a source, such as disk usage, failed service, listener, or log signature.
- Analysis: deterministic or LLM-assisted interpretation that cites source IDs and labels inference separately from direct observations.

## Storage

Migration `010_blackbox_incidents.sql` adds:

- `blackbox_incidents`
- `blackbox_captures`
- `blackbox_sources`
- `blackbox_observations`
- `blackbox_analyses`
- `blackbox_notes`
- `blackbox_links`
- `blackbox_events`

Large redacted artifacts are stored under `SIDEKICK_DATA_DIR/blackbox-artifacts`. Each source records byte counts and SHA-256 content hashes. Legacy `blackbox.json` metadata and `blackbox/` payloads are imported idempotently, preserving original IDs and keeping a backup of the legacy metadata.

## Profiles

- `quick`: identity, load, memory, disk, failed services, processes, listeners, routes, and recent critical context where available.
- `standard`: broad incident context for normal troubleshooting.
- `deep`: expanded logs, kernel warnings, containers, and broader diagnostics.
- `network`: addresses, routes, DNS, listeners, and connection state.
- `service`: service-focused systemd state and logs.
- `sidekick`: Sidekick self-diagnostic sources.
- `repository`: repository and development context.
- `custom`: explicit collector-key selection. Custom unrestricted shell strings are not accepted by the medium-risk interface.

Collectors use argument arrays, explicit timeouts, output limits, stdout/stderr separation, redaction before persistence, source-level failure reporting, and terminal-control stripping.

## MCP Actions

Legacy actions remain available:

- `capture`
- `list`
- `get`
- `delete`
- `analyze`

Structured actions include:

- `capture_status`
- `cancel_capture`
- `list_incidents`
- `get_incident`
- `list_captures`
- `get_capture`
- `list_sources`
- `get_source`
- `search`
- `compare`
- `add_note`
- `update_incident`
- `pin`
- `extend_retention`
- `archive`
- `export`
- `storage_status`
- `purge_preview`
- `purge`
- `profiles`

Structured responses are concise JSON by default. Raw evidence requires source inspection or export.

## Dashboard

The dashboard has a Black Box tab with:

- incident list with search and lifecycle filtering;
- storage summary;
- capture action with profile selection;
- incident overview with lifecycle, severity, host, retention, and expiry;
- source evidence grid with state, duration, exit code, timeout/truncation/redaction badges, hash, stdout/stderr, and normalized output;
- analysis view with cited source IDs;
- timeline events;
- pin and export controls.

Dashboard APIs are authenticated, covered by the existing origin checks, and never expose unrestricted artifact paths.

## Retention

Retention classes are `transient`, `standard`, `important`, `archive`, and `pinned`.

- Pinned incidents never expire automatically.
- Open, investigating, and mitigating incidents do not expire solely due to age.
- Purge has a dry-run preview.
- Deletion removes indexed records and artifact files together.

Environment settings include:

- `SIDEKICK_BLACKBOX_TTL_TRANSIENT_DAYS`
- `SIDEKICK_BLACKBOX_TTL_STANDARD_DAYS`
- `SIDEKICK_BLACKBOX_TTL_IMPORTANT_DAYS`
- `SIDEKICK_BLACKBOX_TTL_ARCHIVE_DAYS`
- `SIDEKICK_BLACKBOX_DAILY_LIMIT`
- `SIDEKICK_BLACKBOX_MAX_BYTES`
- `SIDEKICK_BLACKBOX_MAX_INCIDENTS`
- `SIDEKICK_BLACKBOX_SOURCE_TIMEOUT_MS`
- `SIDEKICK_BLACKBOX_SOURCE_LIMIT_BYTES`
- `SIDEKICK_BLACKBOX_TOTAL_TIMEOUT_MS`

## Security Model

Captured logs and command output are untrusted data. Black Box strips terminal control characters, redacts sensitive values before writing artifacts, caps source output, records truncation, avoids shell interpolation, validates IDs before filesystem access, and stores artifacts under a fixed directory.

LLM analysis receives redacted structured observations and bounded source excerpts. Analysis output is treated as untrusted, schema-normalized, and evidence-cited. Remediation is never performed automatically because analysis recommends it.

## Integrations

- Activity correlation is represented by incident/capture/source timeline events and tool log correlation IDs where available.
- Task/session IDs are stored on incidents and captures when supplied by MCP environment or request metadata.
- Handoffs should link to incident IDs and cite important source IDs instead of copying raw captures.
- Incident memory should be derived only from confirmed root causes, verified fixes, reusable failed approaches, recurring symptom patterns, and unresolved follow-ups.
- Baseline and snapshot comparison can use `compare` over normalized observations; expected behavior remains separate from incident evidence.

## Troubleshooting

- Use `storage_status` to inspect counts, active captures, and artifact size.
- Use `purge_preview` before retention cleanup.
- Use `get_source` for explicit source failures, timeout status, and redacted stdout/stderr.
- Legacy migration errors are stored in the `meta` key `blackbox_legacy_migration_errors`.
