# Jellyfin pack: playback diagnosis

`playback_diagnose` uses the active Jellyfin session and its `TranscodingInfo`. A reported transcode reason is evidence; codec, bitrate, subtitle, HDR, or hardware conclusions are not invented when Jellyfin does not expose the relevant field. Host GPU and container device failures remain an external infrastructure dependency.
Active sessions expose `PlayState.PositionTicks` when Jellyfin provides it.
The pack returns this as `playback_position.ticks` plus converted seconds and
minutes, along with `is_paused` and `can_seek`. This is an exact point-in-time
observation from the `/Sessions` response, not a continuously streamed clock;
query again to refresh it. A missing position is reported as null rather than
inferred from the saved per-user resume position.
