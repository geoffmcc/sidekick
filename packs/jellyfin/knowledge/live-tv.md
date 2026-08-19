# Jellyfin pack: Live TV inspection

Live TV inspection is read-only and profile-scoped. `live_tv_status` and `tuner_status` derive availability and tuner identities from Jellyfin's `LiveTv/Info`; Jellyfin does not provide a dedicated read-only tuner-listing route in the supported API surface.

When Live TV is enabled, `live_tv_channels`, `live_tv_guide`, `recording_status` and `live_tv_timers` read bounded channel, program, recording and timer data. Results preserve Jellyfin record counts where available and label returned rows as bounded. Guide date and channel filters should be used to keep requests focused.

An unavailable or disabled Live TV facility is reported as unavailable with the reason. The pack never creates, updates, cancels or deletes recordings, timers, tuner hosts or programs. Recording failures are observations from Jellyfin's returned status fields and do not establish tuner, antenna, network or storage root cause without independent evidence.
