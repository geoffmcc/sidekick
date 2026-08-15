# Proxmox pack: provisioning, provenance and controlled automation

Phase 2 adds the mutating half of the pack: creating and shaping guests,
recording what Sidekick owns, gating consequential operations with
deterministic policy, and optionally configuring hosts with Ansible.

## The control model

A caller — human, workflow, or agent — never receives raw Proxmox API access.
It invokes a narrow, named capability; Sidekick decides whether and how the
operation runs. Every security decision is made by code, never by a language
model:

```
caller -> capability request -> policy + provenance + risk (deterministic code)
       -> Proxmox API -> task monitoring -> result + audit + event
```

## Provisioning tool: `proxmox_provision` (risk: high)

| Action | Effect |
|---|---|
| `create_vm` | Create a QEMU VM (optionally with a disk, NIC, ISO). |
| `create_lxc` | Create a container from an OS template. |
| `clone` | Clone a template/guest into a new guest, with optional cloud-init. |
| `configure` | Change cpu/memory/description on an existing guest. |
| `snapshot_create` | Snapshot a guest. |
| `convert_template` | Convert a guest into a clone template. |

Every action supports `dry_run: true`, which returns a resolved **explain**
plan — target, node, protection state, provenance, expected effect, and the
policy decision — without making any change. The plan is generated from
resolved facts and deterministic policy, never narrated by a model.

Operations that return a Proxmox task (create/clone/snapshot) are monitored to
a terminal state; `configure` is synchronous and is verified by reading the
config back. Mutations are never retried after an ambiguous failure.

## Provenance: ownership is proved, never assumed

Everything the pack creates is stamped with two independent markers:

- a Proxmox **tag** `sidekick-managed` (and `sidekick-test` for disposable test
  resources), and
- a parseable **marker block** in the guest description carrying the pack, the
  run/correlation id, a unique per-resource marker, and the test flag.

A consequential operation reads the guest back and requires **both** the tag
and the marker to agree before it treats the guest as Sidekick-owned. A
familiar-looking name is never accepted as proof. Each created/changed resource
also emits a `proxmox.*` platform event, giving Sidekick a durable, correlated
record beyond the tool audit log.

## Protected resources and policy

An administrator can make guests untouchable by mutating/destructive operations
through pack configuration:

```json
"protected_resources": [ { "vmid": 105 }, { "tag": "production" }, { "name": "prod-*" } ]
```

A match — or Proxmox's own `protection` flag — is a hard deny that no other
policy overrides. It is enforced on every operation that acts on an existing
guest: `configure`, `convert_template` and `snapshot_create`; the **source
guest of a `clone`** (duplicating a protected VM's disks is itself an act on
it); every `proxmox_guest` lifecycle action — `start` included, because a
deliberately stopped protected guest (quarantine, maintenance) must stay
stopped; `proxmox_migrate`; and `proxmox_retire`.

## Destructive operations: guarded retirement only

Destruction is a privileged capability, not an ordinary HTTP verb. The pack
ships exactly one delete path — `proxmox_retire` (risk `critical`) — and it
fails closed at every layer, in order:

1. **Administrator enablement.** `allow_destroy: true` must be set in pack
   configuration. There is no per-call argument that enables destruction, and
   no force or bypass flag exists anywhere in the tool schema.
2. **Fresh facts.** The guest is looked up and its config read immediately
   before the decision — never from a cached or caller-supplied claim.
3. **Positive provenance.** The guest must carry the `sidekick-managed` tag
   AND a parseable Sidekick marker block, both agreeing. `require_test`
   demands the disposable-test marking, and `marker` demands the exact
   recorded per-resource marker. Ownership is proven, never assumed.
4. **Protection.** A configured `protected_resources` match or Proxmox's own
   protection flag is a hard deny that nothing overrides.
5. **Deterministic decision + explain.** The policy decision and
   expected-effect plan are produced before Proxmox receives a DELETE;
   `dry_run: true` returns the plan and stops.
6. **Completion and absence verification.** The retirement task's UPID is
   monitored to a terminal state, and the guest's absence is re-verified
   afterward. A completed task whose guest still exists is
   `reconciliation_required`, never a success.

Anything outside this envelope — volumes, snapshots, foreign or unmarked
guests, protected guests, host/cluster administration — remains deliberately
unshipped.

## Optional Ansible: `ansible_run` (risk: high)

Ansible is optional and detected, never required or auto-installed. When
present and configured, it configures reachable hosts:

- `detect` — report availability and configuration state.
- `dry_run` — return the exact resolved command, generated inventory, and the
  extra-var keys (values omitted), without executing.
- `run` — execute an **allowlisted** playbook against a **generated** inventory
  through Sidekick's governed shell, reporting per-host results parsed from
  Ansible's JSON output.

A caller can never supply a playbook path, role, ad-hoc module, inventory
script, callback plugin, or command argument — only an allowlisted playbook
name, structured validated hosts, and scalar extra-vars. Host key checking
stays on. Configure it with `ansible.playbook_dir` (and optionally
`ansible.allowed_playbooks`).

## Reproducible environments

The `proxmox/provision-guest` workflow is the reproducible-environment
mechanism: a versionable definition that provisions a Sidekick-managed guest
and validates it. Higher-level workflows (development, CI, testing, training,
future research) compose these generic infrastructure capabilities; the Proxmox
pack never needs to know why the environment exists.
## Disposable cleanup

Resources created for disposable work carry both the `sidekick-managed` tag
and a Sidekick provenance marker. Security Research records the exact marker
in run custody and requests cleanup through `proxmox_retire`; it never issues
its own Proxmox DELETE. Retirement remains pending/manual when
`allow_destroy` is disabled, provenance does not match, or either Sidekick or
Proxmox protection applies.
