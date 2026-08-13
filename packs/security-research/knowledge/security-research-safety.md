# Security Research pack: scope, policy and probe safety

Research intent confers no special privilege. Every action still passes through
Sidekick's policy, approval, timeout, redaction and audit path, and every
provider's own guardrails still apply.

## Scope

A campaign may carry a **scope snapshot** — an explicit allowlist of targets and
operations (`research_scope action=create`). When a run has a scope snapshot,
every probe target/operation is evaluated against it (`evaluateScope`) and an
out-of-scope probe is refused with `scope_denied`.

Default behavior favors local, private and explicitly configured environments.
Authorization is never inferred from public accessibility: a domain responding
on the Internet is not in scope unless a snapshot says so.

## Probe safety

A probe is typed, bounded, and auditable — never an arbitrary shell.

- **`command` probes** compose the governed `bash` tool and run on the **local
  host only**. They are refused unless `allow_local_probes: true` is explicitly
  set, and a non-local environment kind (`remote`/`disposable`/`proxmox`) is
  refused rather than silently running on the host. An explicit `workdir` is
  confined to the workspace.
- **`http` probes** compose `web_fetch`. Without a scope snapshot they require a
  host in `http.allowed_hosts`, and private/loopback/link-local targets are
  refused unless `http.allow_private_addresses: true` (an SSRF guard, enabled
  only for intentionally provisioned private labs).

There is no mass scanning, no autonomous target discovery, and no uncontrolled
traffic generation.

## Provider policy is never bypassed

The principle holds for every capability this pack composes now or later. When a
future increment lets a run provision infrastructure through the Proxmox pack, a
destructive provider operation is decided by the Proxmox pack's own controls —
the Security Research pack cannot say "this is research, therefore allow it." If
cleanup is not authorized, it is reported as pending/manual rather than forced.

## Risk and approvals

Probes and runs are high-risk tools; campaign/hypothesis/evidence/report
management is medium; status and comparison are low. Risk and approval are
decided by Sidekick's native model outside the LLM. Composed calls are subject
to the module permission allowlist (a deny-by-default set of exactly the tools
this pack may dispatch, each with a risk cap).

## Observations vs. conclusions

Raw probe output is stored as an **observation**. Interpretation ("this looks
like an authorization-boundary failure") is kept separate and never overwrites
the observation. A finding is only `confirmed` when the kernel's invariant is
satisfied: a completed run with evidence.
