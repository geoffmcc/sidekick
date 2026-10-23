# Proxmox pack: workflow and action reference

Use environment, cluster, guest, storage, backup, and upgrade workflows for
read-only inspection. Read-only results do not imply quorum, guest readiness,
backup recoverability, or upgrade safety; compare task status, storage capacity,
guest configuration, and backup verification evidence separately.

`provision-guest` is the controlled creation path. Lifecycle, migration, and
retirement remain distinct governed actions. Mutations select a named profile,
check protections and current state, monitor the Proxmox UPID to completion,
and verify postconditions. Migration is same-cluster only. Retirement is not a
general delete: it requires administrator enablement, positive Sidekick-managed
provenance, no protection, and disposable-resource policy. Optional Ansible is
limited to configured allowlisted playbooks and hosts for planning. `detect`
and `dry_run` are available; `run` returns `capability_unavailable` until a
scoped network broker and isolated workspace are implemented. Do not enable
host networking on the general shell as a workaround.

For a node maintenance window, run `proxmox/maintenance-plan` with a configured
profile and node name. It assesses up to 25 guests against up to four online
peer candidates through the normal migration planner. Omitted guests or peers
require operator review. It does not move
guests or prove target capacity, workload health, or backup recoverability;
review each candidate and execute any approved move separately.

If a create or clone task is ambiguous, the result is
`reconciliation_required` and includes the resource identity, UPID, and
recovery actions. Inspect the task and guest before retrying. An orphaned clone
without provenance must be reconciled before retirement can be considered.
