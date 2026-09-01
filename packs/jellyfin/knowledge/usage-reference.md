# Jellyfin pack: workflow and action reference

Use `catalog-browse`, `media-info`, and `user-media-overview` for read-only
catalog and watch-state questions; `library-audit`, `content-health`,
`library-analytics`, and `metadata-completeness` for library quality; and
`playback-diagnose` for session and transcoding evidence. `server-audit`,
`health`, `live-tv-status`, `incident`, and `upgrade-readiness` provide separate
operational views, not interchangeable health claims.

`maintenance-preflight` is a safety assessment. Library scans and task control
require an explicitly writable named profile, storage preflight, approval, and
postcondition verification. Playback diagnosis is read-only; targeted playback
control is separate and requires explicit profile permission plus an unambiguous
active session. Do not expose API keys, private profile data, or page-derived
content.
