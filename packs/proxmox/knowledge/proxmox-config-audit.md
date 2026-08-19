# Proxmox pack: normalized guest configuration audit

`guest_config_audit` provides a bounded, read-only view of one guest's
Proxmox configuration. It reports normalized CPU, memory, boot, startup,
protection, guest-agent, cloud-init, disk, network and tag facts, plus findings
such as a lock, enabled protection, missing interfaces or unavailable QEMU
guest-agent enrichment.

The action is an observation of the current Proxmox configuration, not a
baseline or drift engine. It does not inspect the guest operating system,
claim application health, verify policy compliance, or return raw
configuration. Secret-bearing field values are omitted and only their field
names may appear in `redacted_fields`.
