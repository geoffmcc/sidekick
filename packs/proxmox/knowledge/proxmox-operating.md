# Proxmox pack: operating model and tools

The Proxmox capability pack lets Sidekick inspect and operate Proxmox VE
environments through the Proxmox API. It contributes two governed tools.

## Tools

### `proxmox` (risk: low, read-only)

One tool, many read actions. Every action selects an administrator-configured
**profile by name** — never a raw endpoint.

| Action | What it returns |
|---|---|
| `cluster_summary` | version, cluster/quorum state, node summary, guest counts, storage types |
| `capabilities` | per-profile capability report (see below) |
| `list_nodes` | normalized node list |
| `node_status` (`node`) | CPU/memory/rootfs/load/uptime/kernel for one node |
| `list_guests` (`node?`, `type?`) | VMs and containers from the cluster resource view |
| `guest_status` (`vmid`, `node?`) | one guest's state, with QEMU guest-agent enrichment when available |
| `list_storage` (`node?`) | storage inventory, normalized |
| `storage_status` (`node`, `storage`) | usage for one storage |
| `list_tasks` (`node?`, `limit?`, `errors?`) | recent tasks, newest first |
| `task_status` (`upid`, `node?`) | terminal/running state of one task |
| `backup_status` | vzdump job configuration and recent backup task outcomes |
| `version` | Proxmox version |
| `list_profiles` | configured profiles and their validity (no secrets) |
| `detect_providers` | optional local automation detected on the Sidekick host |

### `proxmox_guest` (risk: high, change)

The controlled guest lifecycle: `start`, `shutdown` (graceful), `reboot`. It
selects a profile that **permits lifecycle operations** (`allow_lifecycle:
true`), checks current state first (idempotent), submits the operation, and
monitors the Proxmox task to a terminal state. Success is derived from task
completion, not from the request being accepted.

It does **not** hard-stop, reset, suspend, delete, clone, migrate, or snapshot,
and it changes no configuration. Those are deliberately absent from this
release.

## The capability report

`capabilities` distinguishes states rather than collapsing them to a boolean:

- `authenticated` / `auth_failed` / `unreachable` for the API itself
- `detected` / `not_detected` / `permission_limited` for Ceph, PBS, SDN
- `configured` / `not_configured` for SDN vnets and cloud-init
- guest-agent counts (guests with the agent enabled), confirmed reachable only
  on demand via `guest_status`
- `installed` / `not_installed` for optional local automation (Ansible, nodex,
  SSH, OpenTofu/Terraform); Ansible reports `execution: governed` because it
  runs through `ansible_run`, while the other providers remain detection-only

An absent subsystem (`Ceph: not_detected`) is a normal answer, never an error.

## What "profile" means

A profile is administrator-configured pack configuration naming one Proxmox
environment: its endpoint, a credential reference, and optional pinned CA. Tools
receive the profile **name**; the endpoint and credential are resolved
server-side. This is what keeps the pack from becoming a way to point
authenticated requests at arbitrary hosts. Configure profiles with
`capability action="configure" name="proxmox"`.

## Multiple environments

More than one profile can be configured (for example `production`,
`research-lab`). When several exist, name one in each call, or mark one
`default: true`.
