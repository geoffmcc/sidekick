# Governed Execution Nodes

Sidekick execution nodes run eligible canonical tools beside source and other
local resources. The server remains the policy, approval, placement, identity,
audit, and recovery authority.

## Trust Boundary

The flow is:

```text
MCP / Agent / Brain -> canonical dispatcher -> policy and approval
  -> deterministic node placement -> authenticated outbound node poll
  -> local descriptor and workspace validation -> real handler
  -> bounded result and receipt -> server audit and caller
```

The node never accepts inbound connections, arbitrary commands, executable job
payloads, caller-supplied descriptors, or unrestricted host paths. Code is
installed as a versioned Sidekick package. A job contains only canonical tool
identity, descriptor version and identity, and validated structured arguments.

The existing compute-worker enrollment and bearer credential authority is reused
for node identity, credential rotation, revocation, heartbeats, and stale-node
handling. Tool jobs use separate `execution_node_jobs` records because their
receipt and ambiguity rules differ from inference jobs.

## Placement

Descriptors expose normalized placement metadata. A tool is node-eligible only
when its descriptor explicitly marks it `nodeSafe`, the node is authorized and
healthy, the protocol and descriptor identity match, and every OS, binary, pack,
workspace, network, browser, and privilege requirement is satisfied. Candidates
are ordered by stable node identity. There is no silent fallback to a more
privileged server location; when no node is eligible the existing local server
handler remains the compatibility path.

Filesystem, Git, repository-development, and semantic tools are eligible when
their local requirements are met. Database, identity, approval, internal
administration, browser, infrastructure, and other server-bound tools are not
advertised by a WSL node. Git network actions additionally require an explicit
node network-scope configuration and are denied when absent. VLAN-specific
scopes are not enabled by this installation.

## WSL Workspace

The initial installation is restricted to the logical workspace
`security-research` at `/home/geoffrey/Projects/security-research`. Repository
discovery is bounded and recursive, skips known dependency/build directories,
handles buried `.git` repositories and worktrees, and produces stable identities
from canonical real paths. Each operation revalidates the workspace and target.

The node rejects relative paths, `..` components, NUL/control tricks, symlink
escapes, special files, protected locations, stale/replaced roots, and paths
outside the authorized workspace. The server authorizes a workspace by logical
name and canonical root identity; the node independently resolves the local
root before execution.

Writes and execution are disabled by default. They require explicit local
configuration and the workspace permission granted by the server. Sensitive
locations such as `.ssh`, `.config`, `.local/share/opencode`, `.sidekick`, and
environment files are never workspace targets.

## Installation

From the repository:

```bash
packaging/execution-node/install-wsl.sh
```

The installer uses user-owned locations: `~/.config/sidekick` for configuration
and credentials, `~/.local/state/sidekick` for state, and `~/.cache/sidekick`
for caches. When `systemd --user` is available it installs
`sidekick-execution-node.service`; otherwise run the packaged binary in the
foreground. The installer creates a config with the security-research workspace
and the Developer pack selected. It does not enroll automatically.

Useful commands:

```bash
sidekick-execution-node status
sidekick-execution-node doctor
sidekick-execution-node enroll
systemctl --user start sidekick-execution-node.service
systemctl --user status sidekick-execution-node.service
systemctl --user restart sidekick-execution-node.service
packaging/execution-node/uninstall-wsl.sh
```

Enrollment tokens are single-use and must be passed through the protected token
file or environment reference on the node. They are never logged or persisted
in ordinary configuration. Rotate or revoke credentials through the existing
compute worker administration surface. A revoked node stops retrying and must be
re-enrolled deliberately.

## Packs and Semantic Repository

The node package contains approved Sidekick source and installed pack code, but
only configured packs are loaded. The Developer pack is required for
`semantic_repo`, `dev_repo_profile`, `dev_change_summary`, and `dev_verify`.
The node computes the same descriptor identity from the local approved code and
rejects missing, inactive, or mismatched pack implementations. Semantic parsing
is the existing deterministic implementation beside the WSL repository; no
second semantic engine is used. Returned projections remain bounded,
hash-verifiable, provenance-linked, and explicitly untrusted source evidence.

## Recovery and Receipts

Jobs have an idempotency key, lease, attempt count, descriptor identity, task and
request identity, optional workspace/repository references, and terminal receipt.
Expired leases are requeued only for the uncompleted tool job. A completed but
unacknowledged operation is not automatically repeated; callers receive the job
identity and receipt state. Node disconnects are detected by the existing
heartbeat reconciliation and do not affect server-only operation.

Receipts identify the node, tool, descriptor, workspace, timing, side-effect
classification, output bounds, and evidence degradation. Tool output, source,
build output, filenames, and semantic text are untrusted evidence and are
redacted and bounded before returning to the server.

## Administration

The controller surfaces node state at `/execution-node/admin/nodes`. An operator
must explicitly authorize a workspace using its logical name and canonical root
identity before placement can select it. Existing disable, enable, revoke, and
credential-rotation controls remain available for the underlying worker
identity. The node heartbeat reports runtime, binaries, configured packs,
workspaces, network scopes, descriptor-set hash, and local limits; server-side
authorization is never inferred from the report alone.

Future Linux, Windows, macOS, and lab nodes use the same protocol. Their
descriptor requirements and authorized scopes determine eligibility; the WSL
implementation is not hard-coded into the server placement algorithm.

## Rollback

Stop and disable the user service, then run `uninstall-wsl.sh`. This removes the
installed node code and service but intentionally preserves credentials and
configuration for inspection or deliberate re-enrollment. Revoke the node from
the server before deleting those files. The migration is additive and can be
rolled back only through the normal database backup/restore procedure; source
tool behavior remains available with no nodes configured.
