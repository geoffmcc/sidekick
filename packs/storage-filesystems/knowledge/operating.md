# Storage and Filesystems

This pack reports storage; it does not format, mount, resize, delete, or
repair filesystems. Host disk evidence comes from the governed status tool.
Proxmox storage capacity and backend evidence comes from provider-native
read-only actions, and container volume inventory comes from the bounded
container provider.

Provider absence, permissions limits, missing capacity fields, and stale
inventory are retained as unknown evidence. Do not interpret an empty volume
list or an unavailable provider as proof that storage is unused or healthy.
