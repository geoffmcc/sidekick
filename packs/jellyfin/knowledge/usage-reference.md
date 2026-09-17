# Jellyfin pack: workflow and action reference

Use `catalog-browse`, `media-info`, and `user-media-overview` for read-only
catalog and watch-state questions; `library-audit`, `content-health`,
`library-analytics`, and `metadata-completeness` for library quality; and
`playback-diagnose` for session and transcoding evidence. `server-audit`,
`health`, `live-tv-status`, `incident`, and `upgrade-readiness` provide separate
operational views, not interchangeable health claims.

To start playback of a known item on a named active device session, run the
governed `play-now` workflow with `device_name` (exact case-insensitive active
session device name, e.g. "Geoffs TV") and `item_id`. It confirms active
sessions and the user's resume list before issuing a single `play` command.
Resolve the `item_id` from `continue_watching` (`user_id` or `username`
required) or another item listing; do not guess session or device ids. Playback
is a mutation: it requires a profile with `allow_playback_control: true` and
does not override existing active playback elsewhere.

The playback-lens workflows resolve the item to play inside the workflow rather
than requiring a caller-provided `item_id`, and all of them first confirm active
sessions:

- `play-next` — play the top next-up episode for `username` on `device_name`.
- `play-resume` — play the top continue-watching item for `username`.
- `quick-play` — search `query` (default includes `Episode,Movie`) and play the
  top matching item.
- `play-recent` — play the most recently added item
  (`include_item_types` defaults to `Episode,Movie`).
- `playback-control` — send a single targeted control command (`action`
  play/pause/resume/stop/seek/fast_forward/rewind/set_volume) to a uniquely
  resolved active session via `session_id`, `device_id`, or `device_name`.
  `item_id` is required only for `play`; `position_seconds` targets an absolute
  seek position, `offset_seconds` a relative one, and `volume` (0-100) is used
  by `set_volume`. Ambiguous targets fail closed with `state_conflict`-style
  errors rather than picking a session.

Read-only views:

- `user-home` — continue-watching, next-up, and recently added for one
  `username` in a single snapshot.
- `new-arrivals` — recently added media (configurable `include_item_types`) plus
  the server metrics summary.
- `session-overview` — current sessions, deterministic playback diagnosis, and
  transcoding summary.
- `catalog-browse`, `media-info`, and `user-media-overview` remain the read-only
  catalog and watch-state workhorses; `playback-diagnose` covers standalone
  session/transcoding evidence.

Playback and control workflows are mutations: they require a profile with
`allow_playback_control: true`, confirm active sessions first, and do not
override existing active playback elsewhere. Numbered-episode plays (e.g. "S01E05")
resolve most reliably through `play-resume`/`play-next` (a user's own watch
state); `quick-play` matches by search title and is best for named titles.
`recently_added`/`recent_media` are server-wide and do not accept a library
filter, so per-library new-arrival views are not available through the current
actions.

`maintenance-preflight` is a safety assessment. Library scans and task control
require an explicitly writable named profile, storage preflight, approval, and
postcondition verification. Playback diagnosis is read-only; targeted playback
control is separate and requires explicit profile permission plus an unambiguous
active session. Do not expose API keys, private profile data, or page-derived
content.
