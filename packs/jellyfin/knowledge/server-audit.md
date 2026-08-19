# Jellyfin pack: server audit and privacy

`server_audit` is a bounded read-only summary of server information, configuration, users, sessions, scheduled tasks and plugins. It reports failed task and malfunctioning-plugin evidence without running tasks, changing configuration, restarting the server or modifying plugins.

The configuration response is recursively sanitized before it leaves the module. Keys associated with passwords, tokens, API keys, credentials, certificates, private keys and secrets are replaced with `[REDACTED]`; raw configuration is never treated as safe to expose. New Jellyfin configuration fields should be reviewed when the server API evolves.

The audit may include operational paths and identity metadata exposed by Jellyfin's server DTOs. Treat those values as private operational data. The audit does not claim historical playback, filesystem health, backup existence or upgrade completion. Those conclusions require the separate evidence-backed readiness and storage surfaces.
