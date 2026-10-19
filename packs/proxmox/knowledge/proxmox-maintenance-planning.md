# Proxmox pack: maintenance and evacuation planning limits

`maintenance_preflight` reports bounded node, guest, task, quorum, HA, and
node-local storage observations. `maintenance_plan` adds candidate online peer
nodes for each guest and asks the same migration resolver used by
`migration_plan` to assess each candidate. `proxmox/maintenance-plan` exposes
that report as a read-only workflow.

This is a proposal, not an evacuation or an upgrade approval. The Proxmox API
facts available here do not establish workload health, free target capacity,
application dependencies, backup recoverability, or a safe maintenance
sequence. Candidate checks are bounded to 25 guests and four online peers;
omitted guests or peers make the plan require operator review. Review each
candidate, check relevant workload and backup evidence, and use a
separately governed `proxmox_migrate` call for every approved move. The pack
does not update hosts, shut down nodes, or evacuate guests automatically.

When a migration task times out or completes without verifying the target
placement, inspect the returned UPID and current guest placement before
retrying. Do not infer that an ambiguous task failed.
