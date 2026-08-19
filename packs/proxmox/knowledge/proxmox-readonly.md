# Proxmox pack: read-only health, capacity and upgrade readiness

The read-only intelligence actions use bounded Proxmox API evidence and never
start, stop, reboot, migrate, snapshot, resize, delete or otherwise mutate a
guest or cluster.

`cluster_health` combines the current cluster/resource summary with a bounded
failed-task query. It reports attention when quorum is lost, nodes are offline
or failed tasks are present. It does not prove application health inside a VM.

`storage_capacity` reports storage totals only when the selected Proxmox
endpoint provides total, used and available byte fields. Missing capacity is
returned as null; the pack does not infer filesystem, ZFS, Ceph or PBS health
from an incomplete storage row.

`upgrade_readiness` is an evidence-based review preflight. It combines version,
cluster health and Proxmox-side vzdump evidence. Missing backup evidence and
recent backup failures are explicitly reported as blockers or review items; it
does not approve or execute an upgrade.
