# Jellyfin Capability Pack

Status: in development (v1.4.4, next bundled first-party release)
Depends on: Capability Packs v1

The Jellyfin pack lets Sidekick securely inspect, diagnose and maintain
Jellyfin media servers through the Jellyfin HTTP API. It is a bundled
capability pack under `packs/jellyfin/`, installed and governed exactly like
the Developer and Proxmox packs: same manifest, managed store, lifecycle,
policy, approval, audit and health model.

The single required dependency is **access to the Jellyfin API** of a
currently supported stable server (10.9/10.10 — every endpoint the pack calls
was verified against the official published OpenAPI for both lines). Proxmox,
host status and outbound release lookup are optional compositions through the
module's declared, deny-by-default dispatch permissions; none is required to
use the read surface.

---

## What it does now vs. later

**Working in v1.1:**

- Administrator-configured named **profiles**, each one Jellyfin server.
  API-key authentication, credential stored in Sidekick's secret store and
  referenced by name; the value never appears in output, logs, errors or
  config.
- TLS verification always on, with **CA pinning** via `ca_pem` or
  `ca_secret_ref` (the resolved CA is threaded into the HTTP client, so both
  forms actually pin). Plain HTTP requires an explicit opt-in. Redirects are
  refused so the credential cannot cross origins.
- Discovery and evidence reads: server profile, capabilities, libraries,
  sessions, scheduled tasks, users, devices, plugins, activity log.
- **Library intelligence**: `library_status` (virtual folders + item counts +
  scan-task state), `library_health` (evidence-based findings — zero-location
  libraries, failed/stale scans — with filesystem accessibility explicitly
  reported as *not verified*), `recent_media`, bounded `library_analytics`,
  `metadata_completeness`, `metadata_issues` and
  `duplicate_candidates` samples that label themselves as samples.
- **Complete catalog browsing**: `list_media` with `all: true` includes every
  Jellyfin item type across every library, including music and collections.
  `recently_added` lists server-wide additions; `continue_watching` and
  `next_up` use explicit user-scoped Jellyfin views without changing watch
  state.
- **Deterministic playback diagnosis** from active-session `TranscodingInfo`,
  naming the chosen session and refusing to guess between several.
- **Bounded log intelligence**: `logs_summary` and `incident_diagnose`
  retrieve only the tail (≤64 KiB) of a server-listed log file (`Range`
  request first, honest refusal when a huge file cannot be tailed), parse
  levels/timestamps, deduplicate error signatures, redact secrets, and never
  return raw log content.
- **Governed storage preflight** composing an independent evidence source
  (Proxmox storage status or Sidekick-host disk status) with a derived
  `safe_for_library_state_mutation`; `not_verifiable` with the missing
  capability named when no provider is configured.
- **Evidence-based readiness**: `backup_readiness` (server paths, running
  tasks, storage state, and vzdump backup evidence for a configured guest —
  a backup is never claimed without evidence) and `upgrade_readiness`
  (version, sessions, tasks, plugins, backup + storage state, optional
  official latest-release lookup; status derived from blockers, never a
  constant).
- **Governed targeted playback** (`jellyfin_playback`): issue a bounded
  `PlayNow` command only to an explicitly selected active device session.
  The Jellyfin user is resolved from that session and the item is looked up
  through `/Users/{session.UserId}/Items/{itemId}`, so watch state is tracked
  per user without assuming a username. Ambiguous or media-control-disabled
  sessions fail closed.
- **Governed maintenance** (`jellyfin_maintenance`): run/cancel scheduled
  tasks and library scans with profile write opt-in, per-action dry-run,
  protected-resource hard denies, storage-preflight gating, and bounded
  postcondition polls that report `state_before/state_after/
  transition_observed` — `verified` only when the transition was observed.
- Read-only catalog, content-health, Live TV and server-audit workflows:
  `jellyfin/media-info`, `jellyfin/library-audit`,
  `jellyfin/content-health`, `jellyfin/live-tv-status`,
  `jellyfin/server-audit`, `jellyfin/catalog-browse`,
  `jellyfin/user-media-overview`, `jellyfin/library-analytics`,
  `jellyfin/metadata-completeness`, alongside the health, playback, maintenance
  preflight, upgrade readiness and incident workflows.

**Architected / deferred (not exposed as working):**

- Historical playback analytics (Jellyfin's API exposes current sessions
  only; `directplay_analysis` says so).
- Server metrics: Jellyfin has **no metrics endpoint** (`/System/Metric` does
  not exist). `metrics_summary` derives a summary from `/Sessions`,
  `/Items/Counts` and `/ScheduledTasks` and names those sources.
- Tuner enumeration: Jellyfin has **no tuner-listing route** (`/LiveTv/Tuners`
  does not exist; `/LiveTv/TunerHosts` is configuration-write only).
  `tuner_status` reports tuner identities from `LiveTvInfo.Services[].Tuners`
  and says exactly that.
- Item deletion, user mutation, plugin install/uninstall, server restart or
  upgrade execution — no destructive or administrative mutation ships.

The pack never advertises a capability it does not perform. A missing
optional facility reports `available: false` / `not_verifiable` with the
reason, not an invented status.

---

## Installation and configuration

```text
capability action="available"                # lists bundled packs incl. jellyfin
capability action="install" name="jellyfin" enable=true
```

### 1. Create a Jellyfin API key

Jellyfin dashboard → Advanced → API Keys → +. API keys act with administrator
scope; treat them accordingly.

### 2. Store the secret in Sidekick

```text
secret action="store" key="jellyfin_home_key" value="<the api key>"
```

### 3. Configure a profile

```text
capability action="configure" name="jellyfin" config={
  "profiles": {
    "home": {
      "endpoint": "https://jellyfin.example.internal",
      "api_key_ref": "secret:jellyfin_home_key",
      "ca_secret_ref": "secret:homelab_ca_pem",
      "allow_writes": false,
      "storage_provider": {
        "type": "proxmox",
        "profile": "production",
        "node": "pve1",
        "storage": "tank",
        "vmid": 120
      }
    }
  },
  "protected_resources": [
    { "kind": "library", "name": "Family Photos" }
  ]
}
```

### Profile fields

| Field | Required | Meaning |
|---|---|---|
| `endpoint` | yes | Server origin (`https://host[:port]`). No path/query/credentials. HTTP only with explicit `allow_insecure_http`. |
| `api_key_ref` | yes | `secret:<name>` reference to the API key in the secret store. |
| `ca_pem` | no | PEM CA to pin (self-signed installs). TLS verification stays on. |
| `ca_secret_ref` | no | `secret:<name>` holding the CA PEM, as an alternative to `ca_pem`. |
| `allow_insecure_http` | no | Default false. Explicit opt-in for internal plain-HTTP deployments. |
| `allow_writes` | no | Default false. Must be true for `jellyfin_maintenance` to act on this profile. |
| `allow_playback_control` | no | Default false. Must be true for `jellyfin_playback` to issue targeted pause, resume, stop, seek, volume, or PlayNow commands. |
| `default` | no | Marks the default profile when several are configured. |
| `request_timeout_ms` | no | Per-request timeout (default 15000, max 120000). |
| `verify_poll_interval_ms` | no | Postcondition poll interval for maintenance verification (default 2000, min 50). |
| `storage_provider` | no | Independent storage-evidence source; see below. |

### `storage_provider`

How the pack independently establishes that library storage is actually
available before any state-affecting maintenance:

- `{ "type": "proxmox", "profile", "node", "storage", "vmid"? }` — reads the
  named storage through the governed `proxmox` read tool (`storage_status`):
  active/enabled state, free bytes, utilization. The optional `vmid`
  additionally enables vzdump backup evidence for `backup_readiness`.
- `{ "type": "local" }` — Jellyfin runs on the Sidekick host; the `status`
  tool's disk section supplies the evidence. This reports the host **root
  filesystem only**, and the result says so (`granularity:
  "host_root_filesystem_only"`) — library paths on other mounts are not
  individually verified.
- Optional thresholds on either type: `min_free_bytes` (default 1 GiB) and
  `max_used_percent` (default 95).
- Unset — `storage_preflight` returns `state: "not_verifiable"`,
  `reason: "no_storage_provider_configured"`, with the required capability
  named, and `safe_for_library_state_mutation: false`. Library-state
  mutation fails closed.

### `protected_resources`

Pack-level list of `{kind, id, name}` entries. Entries with `kind` absent or
`"library"` protect Jellyfin libraries by `ItemId` or exact (case-insensitive)
name: a protected library is a **hard deny** for `scan_library`, and a full
scan (`all_libraries: true`) is denied outright if *any* library is protected,
because `POST /Library/Refresh` touches everything.

The former `allow_destructive` knob was removed from the configuration schema:
nothing in the pack performs a destructive operation, so the knob was dead
configuration implying a capability that does not exist.

---

## Tools and risk classification

| Tool | Risk | Purpose |
|---|---|---|
| `jellyfin` (alias `jf`) | **low** (read) | All read/discovery/diagnosis/readiness actions. |
| `jellyfin_maintenance` (alias `jf_maintenance`) | **high** (change) | run_task / cancel_task / scan_library with dry-run and postcondition verification. |
| `jellyfin_playback` (alias `jf_playback`) | **high** (change) | Targeted PlayNow, pause, resume, stop, seek, and volume commands for an active device session with user-scoped verification. |

`jellyfin` read actions: `list_profiles`, `status`, `health`,
`server_profile`, `version`, `capabilities`, `system_info`, `list_libraries`,
`library_status`, `library_health`, `search_media`, `item_details`,
`recent_media`, `library_analytics`, `metadata_completeness`, `metadata_issues`,
`duplicate_candidates`, `list_sessions`,
`playback_diagnose`, `directplay_analysis`, `transcoding_summary`,
`list_tasks`, `task_status`, `maintenance_plan`, `storage_preflight`,
`list_users`, `user_status`, `user_access_audit`, `list_devices`,
`list_plugins`, `plugin_status`, `metrics_summary`, `activity`,
`logs_summary`, `incident_diagnose`, `backup_readiness`, `upgrade_readiness`,
`library_audit`, `content_health`, `server_audit`, `live_tv_status`,
`tuner_status`, `recording_status`, `live_tv_channels`, `live_tv_guide`,
`live_tv_timers`, `list_collections`, `list_playlists`, `user_media_state`,
`user_unwatched`, `recently_added`, `continue_watching`, `next_up`.

Per-action honesty notes:

- `maintenance_plan` bases recommendations on `LastExecutionResult.Status`
  (Completed/Failed/Cancelled/Aborted) and stale execution dates —
  `TaskInfo.State` is only Idle/Running/Cancelling and never reports failure.
- `recent_media` uses `GET /Items?SortBy=DateCreated&SortOrder=Descending&
  Recursive=true`, which works server-wide with an admin API key; no user
  context is required or resolved.
- `list_media` keeps the focused Movie/Series default, but `all: true` omits
  `IncludeItemTypes` so Jellyfin returns all item types across all libraries;
  pagination remains capped by `max_items`.
- `continue_watching` uses `/Users/{id}/Items/Resume` and `next_up` uses
  `/Shows/NextUp` with an explicitly resolved user. Neither endpoint writes
  watch state.
- `metadata_issues` / `duplicate_candidates` are bounded samples and return
  the exact filters used; duplicate groups are labelled *candidates*, never
  confirmed duplicates.
- `library_audit` and `content_health` inspect bounded per-library samples and
  report counts, codecs, years, missing metadata, images, provider IDs and
  runtimes without claiming filesystem health.
- `server_audit` returns a bounded server/task/plugin/user/session summary and
  recursively redacts sensitive configuration keys; raw secrets are never
  returned.
- `live_tv_channels`, `live_tv_guide` and `live_tv_timers` are GET-only and
  report bounded channel/program/timer data when Live TV is enabled.
- `list_collections` and `list_playlists` are bounded catalog reads. The
  user-scoped `user_media_state` and `user_unwatched` actions require an
  explicit `user_id` or exact `username`; the latter is an unplayed view, not
  a recommendation or behavioral inference.
- `user_status` requires `user_id` or `username`; `plugin_status` requires
  `plugin_id` (or `query` for an exact name match). `user_access_audit`
  flags administrators, disabled accounts, remote access, all-folder vs
  restricted access, and inactivity from `/Users` policy evidence.
- `activity` handles the real `{Items, TotalRecordCount}` response shape and
  supports `start_index`.
- `logs_summary` accepts `log_file`, but only names the server itself listed
  in `GET /System/Logs`; the tail request is bounded and raw content is
  withheld (`raw_output_withheld: true`).
- `storage_preflight` accepts `require_safe: true` to fail (rather than
  report) on anything but verified-ok storage — that is what makes the
  maintenance-preflight workflow actually fail on unsafe storage.
- `playback_diagnose` reports `session_chosen` with the selection reason when
  no `session_id` was given, and returns `ambiguous_sessions` with candidates
  instead of silently picking one of several.
- `list_sessions` includes the active item's runtime under
  `media.runtime` (`ticks`, `seconds`, and `minutes`) when Jellyfin provides
  `RunTimeTicks`, so remaining playback time can be calculated from the live
  position without a second item lookup.
- An authentication failure surfaces as `authentication_failed` everywhere —
  it is never converted into "capability unavailable".

`jellyfin_playback` semantics:

- Every action requires the profile's `allow_playback_control` and an active
  media-control-capable session selected by exact session ID, exact device ID,
  exact device name, or one unambiguous eligible session.
- `play` requires an item ID and resolves it through the selected session's
  Jellyfin user. `pause`, `resume`, and `stop` use the matching play-state
  command; `seek` accepts absolute or signed relative seconds;
  `fast_forward` and `rewind` accept a positive relative offset in seconds
  (for example, 1800 for 30 minutes); `set_volume` accepts only 0 through 100.
- User identity is always taken from the selected session's `UserId`; a
  configured or assumed username is never substituted. Every command returns
  bounded postcondition evidence and reports `request_accepted` when the
  target does not confirm the new state within the verification window.
- DLNA renderers may advertise only volume/audio commands even when Jellyfin
  can route pause, stop, and seek through the session play-state endpoints.
  The pack permits those controls only for an explicitly identified DLNA
  session with `SupportsMediaControl: true`; seek additionally requires
  `PlayState.CanSeek: true`. DLNA `SetVolume` compatibility for issue #506 is
   likewise limited to sessions with explicit `SupportsMediaControl: true`;
   volume remains a high-risk, profile-opt-in mutation and is never part of the
   read tool.
- The pack's ten manifest-registered knowledge documents cover operating
  model, catalog, Live TV, server audit, user media, analytics, safety,
  playback diagnosis, targeted playback control, and maintenance. New users
  receive these entries when the pack is installed or refreshed.

`jellyfin_maintenance` semantics:

- Every action requires the profile's `allow_writes`.
- Required arguments are validated **before** a dry-run plan is produced (a
  dry run of an unexecutable request fails with `invalid_input`), and
  `expected_effect` is per-action accurate.
- `scan_library` requires `library_id` (validated against
  `/Library/VirtualFolders` `ItemId`) or an explicit `all_libraries: true`;
  runs the real storage preflight and fails closed
  (`unsafe_storage_state`) unless the state is verified ok; enforces
  `protected_resources`; executes `POST /Items/{id}/Refresh` or
  `POST /Library/Refresh`; then polls briefly and reports the outcome as
  `accepted` / `running` / `verified` with the semantics spelled out in the
  result.
- `run_task`/`cancel_task` poll up to 3 times for the state transition and
  report `postcondition: {state_before, state_after, transition_observed}`;
  without an observed transition the outcome is `request_accepted`, not
  `verified`.

### Module dispatch permissions

The module declares exactly three facade permissions (deny-by-default risk
caps in `manifest.json`): `proxmox` (low, storage/backup evidence), `status`
(medium, local disk evidence), `web_fetch` (medium, official release lookup
for `upgrade_readiness` — a failed lookup reports `latest_stable: "unknown"`,
never a guess). Everything else the pack does over its own authenticated
HTTPS client. No shell permission exists.

---

## Security model

- **No model-supplied endpoints.** Tools take a profile *name*; the endpoint
  comes from trusted configuration and is validated (origin only, no
  credentials/query/fragment, HTTP only by explicit opt-in).
- **Credentials never leak.** The API key is resolved server-side at call
  time, used only in the `Authorization` header, scrubbed from error text,
  and never appears in results or configuration.
- **TLS is never silently weakened.** No insecure mode exists; self-signed
  deployments pin their CA (`ca_pem`/`ca_secret_ref` — both are honoured).
- **Bounded responses everywhere**: item queries, activity, logs (tail only),
  response-size caps in the client; 400 maps to `invalid_input`, 429 to
  `rate_limited`.
- **Mutation is opt-in and evidence-gated**: profile `allow_writes`,
  protected resources, storage preflight, dry-run previews, and honest
  postconditions. There is no force or bypass argument.

---

## Workflows

| Workflow | Mode | Notes |
|---|---|---|
| `jellyfin/health` | read-only | Server profile + scheduled tasks. |
| `jellyfin/playback-diagnose` | read-only | Sessions + deterministic diagnosis. |
| `jellyfin/maintenance-preflight` | read-only | Storage step passes `require_safe: true`, so the workflow **fails** unless storage is verified safe. |
| `jellyfin/upgrade-readiness` | read-only | Evidence-derived readiness + plugin inventory. |
| `jellyfin/incident` | read-only | Diagnosis, log summary, activity, sessions, tasks; each step carries its own evidence — no source is claimed unless its step succeeded. |
| `jellyfin/media-info` | read-only | Item, series, season, episode, runtime and stream inspection. |
| `jellyfin/library-audit` | read-only | Bounded per-library catalog aggregates and item sample. |
| `jellyfin/content-health` | read-only | Bounded missing metadata/image/provider/runtime findings. |
| `jellyfin/live-tv-status` | read-only | Live TV services, channels, guide, recordings and timers. |
| `jellyfin/server-audit` | read-only | Sanitized server configuration and operational summary. |
| `jellyfin/catalog-browse` | read-only | Collections and playlist inventory. |
| `jellyfin/user-media-overview` | read-only | Explicitly user-scoped unplayed media and watch state. |

---

## Limitations

- Filesystem accessibility of individual library paths is not observable
  through the Jellyfin API; that is exactly what `storage_provider` exists
  for, and `library_health` lists it under `not_verified`.
- The `local` storage provider sees only the host root filesystem.
- Backup evidence is Proxmox vzdump job/task history (when configured with a
  `vmid`); the pack never claims a backup exists without that evidence.
- Log retrieval depends on the server honouring `Range` for large files; a
  large file without range support is refused honestly
  (`log_too_large_without_range_support`), not partially misrepresented.
- Live TV data comes from `LiveTv/Info`, `LiveTv/Channels`,
  `LiveTv/Programs`, `LiveTv/Recordings` and `LiveTv/Timers`; tuner
  enumeration beyond `Services[].Tuners` does not exist in the Jellyfin API.

---

## Testing

The offline suite (`test/jellyfin-pack.test.js`) covers profile parsing
(including `storage_provider` shapes), log summarization/redaction, and the
full entry surface against canned fixtures with the HTTP client and secret
resolution stubbed — every declared read action, the maintenance guard
matrix, storage preflight in all three provider modes, postcondition polls,
dry-run validation, the TLS CA-threading regression, and a loopback
real-client check for 400/429 classification and true `Range` tails.
`test/jellyfin-lifecycle.test.js` installs, enables, health-checks, disables
and uninstalls the pack through the real pack lifecycle.

## Related documents

- `docs/capability-packs.md` — the pack lifecycle this builds on
- `docs/proxmox-pack.md` — the Proxmox pack composed for storage/backup evidence
- `packs/jellyfin/knowledge/*.md` — operating model, safety, playback,
  maintenance (searchable through the `knowledge` tool once installed)
