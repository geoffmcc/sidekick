# Jellyfin pack: maintenance and storage safety

Configured library paths are not proof that storage is available. `storage_preflight` therefore returns `unknown` unless a governed provider can establish availability. State-affecting library maintenance fails closed on unknown storage. Scheduled task operations resolve the exact current task ID, avoid automatic retries for mutations, and verify the postcondition where Jellyfin exposes it.
