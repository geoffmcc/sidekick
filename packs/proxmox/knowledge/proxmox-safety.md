# Proxmox pack: task semantics and operational safety

## Proxmox operations are asynchronous

Most Proxmox mutations return a **UPID** (a task id) immediately; the work
happens afterward. The pack never reports success because the API accepted a
request. For a lifecycle action it obtains the UPID, polls the task, and
determines the terminal outcome from the task's `exitstatus` (`OK`, or
`WARNINGS: ...`, is success; anything else is failure).

Consequences worth knowing:

- **Graceful shutdown and reboot need the guest to cooperate.** They rely on
  ACPI or the QEMU guest agent. A guest without either will not complete the
  task; the pack reports `task_timeout` — an honest "did not finish", not a
  false success and not a hard power-off.
- **A submitted operation is never silently retried.** The client retries only
  idempotent reads, and only on transient transport errors. A power operation
  that fails ambiguously (e.g. a timed-out submit) is surfaced for inspection,
  never replayed.
- **Auth failures during polling are terminal.** If a token is revoked while a
  task runs, the task may still complete server-side, but the poller stops
  rather than looping on a permanent 401/403.

## Idempotency

The lifecycle tool checks current state first:

- start on a running guest → `already_running` (no-op)
- shutdown on a stopped guest → `already_stopped` (no-op)
- reboot on a non-running guest → a clear `guest_not_running` error
- a template → rejected; lifecycle operations do not apply to templates

## TLS

TLS verification is always on. Proxmox installations commonly use a self-signed
cluster CA; support it by **pinning** that CA (`ca_pem`, or `ca_secret_ref`),
not by disabling verification — there is no insecure mode. The cluster CA is at
`/etc/pve/pve-root-ca.pem` on any node. A verification failure is reported as a
distinct `tls_failure` with this guidance, never as a generic network error.

## Cluster maintenance is deliberately not automated yet

This release does not perform rolling cluster upgrades, node evacuation, or
reboots-for-maintenance. Doing that safely requires reasoning about quorum, HA,
guest placement, migration capability, storage and (where present) Ceph health,
plus post-reboot verification — a durable, resumable workflow. The read tools
here (`cluster_summary`, `capabilities`, `list_tasks`, `node_status`) are the
inputs such a workflow will need; the workflow itself is future work. Until it
exists, sequence maintenance yourself and use these tools to verify each step.
