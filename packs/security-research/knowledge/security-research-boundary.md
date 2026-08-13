# Security Research pack: public/private workspace boundary

This pack enforces a hard, one-way boundary:

```
Private research workspace  --uses-->  Public Sidekick capabilities
```

never the reverse. The public Sidekick repository must never become the storage
location for real research.

## The external workspace

All target-specific research — evidence, run artifacts, report material — lives
in a configurable external workspace, resolved from (in order):

1. the pack's `workspace` configuration value, else
2. the `SIDEKICK_RESEARCH_WORKSPACE` environment variable.

Real paths belong in ignored local configuration or the environment, never in a
committed file. Public examples always use generic placeholders such as
`/path/to/security-research` or `${SIDEKICK_RESEARCH_WORKSPACE}`.

## Fail-closed workspace safety

The workspace is canonicalized through `realpath` (so `..` and symlinks cannot
disguise where it points) and is refused when it resolves to, contains, or is
contained by:

- the Sidekick source repository,
- the Sidekick data directory,
- the managed capability-pack store,

or when it is dangerously shallow (a filesystem root or the OS temp root). A
misconfigured workspace fails closed with a clear error; it never silently
writes into the repository.

## What Sidekick stores vs. what stays private

- **In the workspace (private):** raw evidence bytes, run observations, report
  material documents.
- **In Sidekick (generic):** references (`artifact:<id>`), SHA-256 content
  hashes, sizes, sensitivity/redaction state, original/derivative lineage, and
  the research state machine. Never the bytes.

`research_evidence action=inspect` returns metadata only — never raw content —
so evidence cannot leak through a tool result or into model context by default.

## Nothing auto-commits or auto-discloses

The pack never runs `git add/commit/push` against a research workspace and never
contacts a vendor or bug-bounty platform. Version control and disclosure remain
explicit, separate, human-authorized actions.
