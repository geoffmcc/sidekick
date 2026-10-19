# Network & Firewall pack: safe changes and management-path protection

The current pack supports read-only planning only. A caller-provided `management_path: "safe"` is not evidence, and the pack has no authenticated, session-bound verifier for Sidekick's management path. Therefore `apply` is blocked for every proposed change; `preflight` records intent but never reports the change as safe to apply. Do not treat plan output as approval or provider verification.

If mutation support is restored in a later release, it must use provider-observed state, a session-bound management-path check, provider-native rollback, and postcondition verification. Never place complete provider configuration backups in normal storage: they may contain passwords, certificates, VPN keys, or Wi-Fi secrets.
