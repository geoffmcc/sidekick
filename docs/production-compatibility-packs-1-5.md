# Production Compatibility Packs 1-5

These five packs are intentionally additive. They contribute namespaced
adapters, workflows, and knowledge only; they do not modify Sidekick's shared
dispatcher, policy, persistence, provider clients, or lifecycle runtime.

## Domains

- `linux-systems-administration`: host status, host health, and one-service systemd operations.
- `observability-incident-response`: Black Box incident capture, independent health review, and metrics provider access.
- `backup-restore-dr`: database backup/restore/diff and Proxmox backup-readiness evidence.
- `storage-filesystems`: host, Proxmox, and container storage inspection.
- `network-services`: network, DHCP, VPN, Nginx, and deterministic connectivity inspection.

All read paths preserve provider failures and unknowns. Mutations are only
forwarded to existing governed tools and retain their underlying risk. Packs
do not detect binaries by running shell commands: provider and binary
availability is reported by the delegated tool's actual configured detection.

Install and enable each pack through the normal capability lifecycle. Inspect
the package first, then test on a disposable instance; pack code runs
in-process and installation is not sandboxing.
