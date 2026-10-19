# Jellyfin pack: playback diagnosis

For "who is watching?", use `jellyfin/session-overview` (or `list_sessions`).
The overview groups media sessions by `user_name`/user ID, so a user watching on
multiple devices appears once with each device session nested under them.
Sessions without a current media item appear separately as connected-only;
they are not described as watching. Each media session includes media title/type and any
series/season/episode context, device and client, runtime, `playback_elapsed`,
`time_remaining`, `progress_percent`, pause/seek state, playback method, and
transcoding details when Jellyfin supplies them. The agent should summarize
one row per user with active or paused playback and include title, elapsed and
remaining time, and device; mention paused or transcoding state when useful.
For sessions with media but no reported pause value, playback state is unknown.

`playback_diagnose` uses the active Jellyfin session and its `TranscodingInfo`.
A reported transcode reason is evidence; codec, bitrate, subtitle, HDR, or
hardware conclusions are not invented when Jellyfin does not expose the
relevant field. Host GPU and container device failures remain an external
infrastructure dependency.

`playback_elapsed` reflects `PlayState.PositionTicks`; `time_remaining` is
runtime minus that position, clamped at zero. Both are point-in-time duration
estimates, not a continuously streamed clock or an estimated wall-clock finish
time. Remaining time is null if runtime or position is unavailable. A missing
position is never inferred from the saved per-user resume position. If playback
is paused, remaining duration is still reported, but no finish time is implied.
