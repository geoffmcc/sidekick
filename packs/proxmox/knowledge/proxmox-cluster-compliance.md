# Proxmox pack: cluster compliance and task observations

`cluster_compliance_audit` is a bounded, read-only current-state view of
cluster quorum, node availability, reported PVE versions, HA resources,
replication jobs and recent task outcomes. It emits normalized facts and
explicit findings for offline nodes, non-quorate clusters, version mismatch
and recent task failures.

HA and replication are optional Proxmox surfaces. When they are unavailable,
the result reports an unknown observation rather than treating the absence of
data as healthy. This action does not compare against a stored baseline,
inspect guest operating systems, or make configuration changes.
