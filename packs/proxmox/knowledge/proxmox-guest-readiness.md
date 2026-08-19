# Proxmox pack: guest inventory and backup coverage

`guest_inventory` is a bounded view of the current `/cluster/resources`
inventory. It summarizes guest type, state, template and lock counts without
claiming operating-system or application health.

`guest_readiness` inspects one VM or container using Proxmox status/config
evidence and optional QEMU guest-agent enrichment. A configured but unreachable
agent is reported as an observation; an unconfigured agent is not treated as a
failure of the guest itself.

`backup_coverage` compares current guest VMIDs with Proxmox-side vzdump job
selections. It does not inspect PBS datastore contents, retention, encryption or
restoreability. An uncovered guest is a review finding, not an instruction to
start a backup.
