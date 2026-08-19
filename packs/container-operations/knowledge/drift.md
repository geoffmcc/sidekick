# Compose validation and drift

Use an explicitly configured Compose root and provider-authoritative validation. Normalize service presence, image references, networks, ports, mounts, restart policy, resources, health checks, labels, and environment-key presence; ignore ordering and provider-generated defaults. Never expose secret environment values. Similar container names alone do not prove a Compose relationship.
