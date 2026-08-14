# Jellyfin pack: playback diagnosis

`playback_diagnose` uses the active Jellyfin session and its `TranscodingInfo`. A reported transcode reason is evidence; codec, bitrate, subtitle, HDR, or hardware conclusions are not invented when Jellyfin does not expose the relevant field. Host GPU and container device failures remain an external infrastructure dependency.
