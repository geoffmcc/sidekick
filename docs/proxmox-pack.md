# Proxmox VE Capability Pack

Status: shipped (v1.0.0, bundled first-party pack)
Depends on: Capability Packs v1

The Proxmox pack lets Sidekick securely discover, understand, monitor and
operate Proxmox VE infrastructure through the Proxmox API. It is a bundled
capability pack under `packs/proxmox/`, installed and governed exactly like the
Developer pack: same manifest, managed store, lifecycle, policy, approval,
audit and health model.

The single required dependency is **access to the Proxmox VE API**. SSH, the
QEMU guest agent, cloud-init, Proxmox Backup Server, Ceph, ZFS, SDN, Ansible,
nodex and Terraform/OpenTofu are all optional and capability-detected; none is
required to use the pack.

---

## What it does now vs. later

**Working in v1 (implemented, tested, and live-verified against Proxmox 9.2):**

- Administrator-configured named **profiles**, each one Proxmox environment.
- API-token authentication, credential stored in Sidekick's secret store and
  referenced by name; the value never appears in output, logs, errors or config.
- TLS verification always on, with **CA pinning** for self-signed installations.
- A Proxmox API client with structured errors, request timeouts, bounded
  responses, correct UPID/task handling, and safe retry policy.
- Normalized read discovery: cluster summary, nodes, guests, storage, tasks,
  vzdump backup configuration/history, version.
- A **capability report** distinguishing installed / configured / reachable /
  authenticated / detected / not-detected / permission-limited / disabled.
- Per-guest QEMU guest-agent enrichment (hostname/OS/IPs) when available, with
  graceful degradation.
- Cloud-init drive detection; storage-type, PBS-as-storage, Ceph and SDN
  detection.
- A controlled **guest lifecycle**: start, graceful shutdown, reboot — with
  state pre-checks (idempotency), asynchronous task monitoring to a terminal
  state, and honest `task_timeout` when a guest cannot complete a graceful
  operation.
- Optional local automation **detection** for nodex, SSH and OpenTofu/Terraform
  (presence only).
- **Provisioning and configuration** (`proxmox_provision`): create VM, create
  LXC, clone (with cloud-init), configure cpu/memory, snapshot, convert to
  template — each provenance-tagged, task-monitored, and with `dry_run`/explain.
- **Resource provenance**: Sidekick-created guests carry a `sidekick-managed`
  tag plus a parseable marker; ownership is proven from both before any
  consequential operation, and each operation emits a `proxmox.*` event.
- **Protected resources and deterministic policy**: `protected_resources`
  (vmid/tag/name-glob) plus Proxmox's protection flag are hard denies enforced
  in code.
- **Optional Ansible execution** (`ansible_run`): detect / dry_run / run of
  allowlisted playbooks against a generated inventory through the governed
  shell, with per-host results parsed from Ansible's JSON output.
- Three workflows: `proxmox/environment-recon`, `proxmox/guest-health`,
  `proxmox/provision-guest` (the reproducible-environment mechanism).

**Architected / deferred (not exposed as working):**

- Destruction (delete VM/container/volume, destroy snapshot). No delete
  capability and no client `delete()` method ship; a single test-only guarded
  DELETE lives in the test/probe harness. Guarded destructive capabilities are
  a future phase (identity + provenance + protection + policy + approval +
  expected-effect preview + audit).
- Migration, and host/cluster administration.
- Direct Proxmox Backup Server API (datastores, verification, prune). Reads
  Proxmox-side (vzdump) backup configuration and task history only.
- Execution through SSH, nodex or Terraform/OpenTofu — detection only.
- Ceph operations beyond health/detection read.
- Rolling cluster maintenance (quorum/HA-aware upgrades and reboots) as a
  durable workflow.

The pack never advertises a capability it does not perform. An optional
integration that is absent reports `not_detected` / `not_installed`, not an
error, and deferred functionality is documented, not stubbed.

---

## Installation and configuration

The pack is bundled; install and enable it through the governed `capability`
tool (or the dashboard Capabilities page):

```text
capability action="available"                 # lists bundled packs incl. proxmox
capability action="install" name="proxmox" enable=true
```

### 1. Create a Proxmox API token

In the Proxmox UI: Datacenter → Permissions → API Tokens → Add. Note the token
id (`user@realm!tokenname`) and the secret shown once. See
[least-privilege](#least-privilege-permissions) for the role to grant.

### 2. Store the secret in Sidekick

```text
secret action="store" key="proxmox_production_token" value="<the token secret>"
```

### 3. Configure a profile

```text
capability action="configure" name="proxmox" config={
  "profiles": {
    "production": {
      "endpoint": "https://pve.example.internal:8006",
      "token_ref": "secret:proxmox_production_token",
      "ca_pem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
      "allow_lifecycle": false
    }
  }
}
```

Both the MCP `capability` tool and the dashboard drive the same governed path.
Non-secret profile settings live in configuration; the token lives only in the
secret store.

### Profile fields

| Field | Required | Meaning |
|---|---|---|
| `endpoint` | yes | `https://host:8006` origin. https only, no path/query/credentials. |
| `token_ref` | yes | `secret:<name>` reference to the API token in the secret store. |
| `ca_pem` | no | PEM CA to pin (self-signed installs). TLS verification stays on. |
| `ca_secret_ref` | no | `secret:<name>` holding the CA PEM, as an alternative to `ca_pem`. |
| `tls_servername` | no | DNS name used for TLS SNI/certificate validation when connecting to an endpoint IP. |
| `allow_lifecycle` | no | Default false. Must be true for `proxmox_guest` to act on this profile. |
| `default` | no | Marks the default profile when several are configured. |
| `request_timeout_ms` | no | Per-request timeout (default 15000, max 120000). |
| `task_poll_interval_ms` | no | Task poll interval (default 1000). |
| `task_timeout_ms` | no | Max wait for a task terminal state (default 120000, max 1800000). |

### Multiple environments

Configure any number of profiles (e.g. `production`, `research-lab`,
`remote-cluster`). Name one per call, or mark one `default: true`. Credentials
are never duplicated into model-visible state; each profile references its own
secret.

---

## Tools and risk classification

| Tool | Risk | Purpose |
|---|---|---|
| `proxmox` (alias `pve`) | **low** (read) | All read/discovery/capability actions. |
| `proxmox_guest` (alias `pve_guest`) | **high** (change) | start / graceful shutdown / reboot. |
| `proxmox_provision` (alias `pve_provision`) | **high** (mutating) | create_vm, create_lxc, clone, configure, snapshot_create, convert_template; `dry_run` for explain. |
| `ansible_run` (alias `ansible_playbook`) | **high** | detect / dry_run / run of allowlisted playbooks (optional; dispatches the governed `bash` tool). |

Operations are split into **separate tools by risk class** because a module
tool's risk is fixed per tool and cannot be lowered per action — reads stay
`low`, mutations stay `high` — so approval policy sees each correctly. The pack
declares one dispatch permission (`bash`, for Ansible only); everything else it
does over HTTPS itself, resolving credentials through Sidekick's secret resolver
in-process.

Destructive operations (delete, destroy disks, migrate, change cluster
membership/quorum, host/guest shell, arbitrary playbooks) are **not present**.
The runtime client exposes no `delete()` method. Destruction is treated as a
privileged capability, not an ordinary HTTP verb, and will ship later only as an
explicit guarded operation. See `packs/proxmox/knowledge/proxmox-provisioning.md`
for the provisioning, provenance, policy and destructive-operation model.

`proxmox` read actions: `cluster_summary`, `capabilities`, `list_nodes`,
`node_status`, `list_guests`, `guest_status`, `list_storage`, `storage_status`,
`list_tasks`, `task_status`, `backup_status`, `version`, `list_profiles`,
`detect_providers`. See `packs/proxmox/knowledge/proxmox-operating.md` for
per-action arguments.

---

## Security model

- **No model-supplied endpoints.** Tools take a profile *name*; the endpoint
  comes from trusted configuration. The pack cannot be turned into an
  authenticated request-forgery primitive into Sidekick's network. Endpoints are
  additionally validated (https only, no credentials/path/query, link-local and
  cloud-metadata hosts refused; private/RFC1918 hosts allowed for homelabs).
- **Credentials never leak.** The API token is resolved server-side from the
  secret store at call time and used only in the `Authorization` header. It
  never appears in a URL, result, log, error or configuration. Proxmox error
  text (which can echo request headers) is scrubbed of the literal token before
  any error is constructed, and Sidekick's dispatcher redaction applies on top.
- **TLS is never silently weakened.** Verification is always on; there is no
  insecure mode and no code path setting `rejectUnauthorized: false`.
  Self-signed certificates are supported only by pinning their CA. A
  verification failure is a distinct `tls_failure` with remediation guidance.
- **Every identifier is validated** before it can reach a request path: VMID
  range, node/storage/profile name shapes, and full UPID structure. Path
  segments are additionally escaped so an identifier can never smuggle path
  syntax.
- **Mutations are never blindly retried.** Only idempotent reads retry, and only
  on transient transport errors. A power operation that fails ambiguously is
  surfaced, not replayed.
- **Auth-during-polling is terminal.** A token revoked mid-task stops the poller
  rather than looping on a permanent 401/403.

---

## Least-privilege permissions

| Intended use | Proxmox role | Notes |
|---|---|---|
| Read-only discovery/status | `PVEAuditor` on `/` | Everything except `proxmox_guest`. |
| Guest lifecycle | `PVEAuditor` + `VM.PowerMgmt` | Grant `VM.PowerMgmt` on `/vms` or specific guests. |
| Broader management | project-specific | Not required by v1; grant deliberately. |

A read-only token is sufficient for all read actions, and a profile is
read-only unless an administrator also sets `allow_lifecycle: true`. A missing
privilege is reported as `permission_denied` (an authorization problem), never
as a network outage. Proxmox silently filters `/cluster/resources` by
permission, so a short guest list can mean a missing `VM.Audit` — `list_guests`
notes this.

---

## Optional capabilities

| Capability | v1 behavior |
|---|---|
| QEMU guest agent | Per-guest detection + hostname/OS/IP enrichment when reachable; degrades cleanly. |
| Cloud-init | Detection of cloud-init drives/keys per guest. Provisioning deferred. |
| Proxmox Backup Server | Detected as a storage backend; vzdump job/history read. Direct PBS API deferred. |
| Ceph | Health/detection read (`detected` / `not_detected` / `permission_limited`). No Ceph ops. |
| ZFS / storage types | Normalized detection of dir, LVM/LVM-thin, ZFS, NFS, CIFS, iSCSI, Ceph/RBD, PBS, etc. None required. |
| SDN | `configured` / `not_configured` detection. |
| Ansible / nodex / SSH / OpenTofu / Terraform | Presence detection on the Sidekick host only; execution deferred. |

Optional providers require their software; installing anything on the Sidekick
host is an operator action. Detection is execution-free (PATH scan) and needs no
shell permission.

---

## Networking note

Do not assume Sidekick can reach a guest merely because Proxmox can. Proxmox
environments use bridges, VLAN-aware bridges, bonds, SDN and isolated guest
networks; guest reachability from the Sidekick host is independent of Proxmox's
own visibility. v1 makes no such assumption — guest enrichment comes through the
Proxmox API and QEMU guest agent, not by Sidekick connecting to the guest.

---

## Live-integration testing

Live tests are opt-in and never run in the normal offline suite. To verify
against a real Proxmox environment, configure a profile as above and run read
actions; they make no changes. For a lifecycle check, use a **designated
disposable guest** and a profile with `allow_lifecycle: true` — never guess
which guest is safe.

The offline suite (`test/proxmox-unit.test.js`, `test/proxmox-pack.test.js`)
covers the pure logic and the full pack path against a local mock Proxmox API,
including real TLS: the mock serves a self-signed certificate that the pack must
validate by pinning, and must reject when the CA is not pinned. The integration
suite skips cleanly if `openssl` is unavailable to generate the mock's
certificate.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `tls_failure` | Self-signed cert not pinned. Set `ca_pem` to `/etc/pve/pve-root-ca.pem` from a node. |
| `auth_failed` (401) | Token id/secret wrong, or secret not stored under the referenced name. |
| `permission_denied` (403) | Token lacks a role/privilege — see least-privilege. Not an outage. |
| `lifecycle_disabled` | The profile has `allow_lifecycle` false; set it true to permit start/shutdown/reboot. |
| `task_timeout` on shutdown/reboot | The guest has no ACPI/guest-agent to complete a graceful operation. |
| Empty/short `list_guests` | Possibly a token without `VM.Audit`; Proxmox filters resources by permission. |
| `not_configured` | No profiles configured; configure one via `capability action="configure"`. |

## Related documents

- `docs/capability-packs.md` — the pack lifecycle this builds on
- `packs/proxmox/knowledge/*.md` — operating model, least-privilege, safety
  (also searchable through the `knowledge` tool once installed)
