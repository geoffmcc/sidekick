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
limited to configured allowlisted playbooks and hosts.
