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

## Maintenance preflight and deferred host maintenance

`maintenance_preflight` combines cluster/quorum state, node online state,
running guests and HA indicators, active backup/migration/replication tasks,
and node storage visibility. It returns `safe_to_begin_preflight_only` only
when the facts it can authoritatively obtain have no blocker. This is not a
claim that package updates or reboots are safe.

Rolling cluster updates, node evacuation, package changes and reboot recovery
remain deferred until a durable workflow and an administrator-approved,
bounded host-maintenance backend are available. Unknown or permission-limited
safety facts must be treated as blocked; they are never promoted to safe.

Migration and retirement are consequential operations: use their dry-run or
explain paths first. A cancelled wait may leave a remote UPID running; inspect
the task before deciding what to do next.
