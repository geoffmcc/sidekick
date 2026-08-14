# Jellyfin pack: profiles and safety

Store API keys in Sidekick's secret store and reference them as `secret:<name>`. Use HTTPS with normal certificate verification. A custom CA may be pinned with administrator configuration. Plain HTTP is denied unless explicitly opted in for an internal deployment. Authenticated redirects are refused so credentials cannot cross origins.

Writes require profile-level administrator enablement and Sidekick risk policy. The pack has no arbitrary URL, endpoint-path, force, or protection-bypass argument.
