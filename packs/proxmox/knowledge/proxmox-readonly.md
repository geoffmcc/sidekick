# Proxmox pack: read-only health, capacity and upgrade readiness

The read-only intelligence actions use bounded Proxmox API evidence and never
start, stop, reboot, migrate, snapshot, resize, delete or otherwise mutate a
guest or cluster.

`cluster_health` combines the current cluster/resource summary with a bounded
failed-task query. Its active-failure assessment window is 24 hours: it reports
attention when quorum is lost, nodes are offline, a failed task is recent, or a
failed task has no timestamp and therefore cannot be assessed. It reports
`recent_failed_tasks`, `historical_failed_tasks`, and timestamp/age evidence
separately. Historical failures alone do not produce attention. The complete
bounded failed-task sample remains in `failed_tasks` for investigation and
audit. It does not prove application health inside a VM.

`storage_capacity` reports storage totals only when the selected Proxmox
endpoint provides total, used and available byte fields. Missing capacity is
returned as null; the pack does not infer filesystem, ZFS, Ceph or PBS health
from an incomplete storage row.

`upgrade_readiness` is an evidence-based review preflight. It combines version,
cluster health and Proxmox-side vzdump evidence. Missing backup evidence and
recent backup failures are explicitly reported as blockers or review items; it
does not approve or execute an upgrade.
