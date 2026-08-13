# Repository reconnaissance (Developer pack)

Before modifying an unfamiliar repository, establish facts rather than
assumptions. `dev_repo_profile` answers most of them mechanically; run it first
and read the result instead of guessing at the project's shape.

## Order of establishment

1. **Repository identity and state** — path, branch, upstream, HEAD, whether the
   working tree is clean. A dirty tree changes what every later observation
   means: test results, diffs and CI comparisons are all against a tree that
   does not match any commit.
2. **Repository-specific instructions** — `AGENTS.md`, `CLAUDE.md`,
   `CONTRIBUTING.md`, `CODEOWNERS`. These are authoritative for that repository
   and override this pack's general guidance wherever they conflict.
3. **Ecosystem and package managers** — the lockfile present decides the
   install command; the manifest present decides the ecosystem. Do not assume
   npm because a `package.json` exists if the lockfile is `pnpm-lock.yaml`.
4. **Verification path** — what the project itself says to run. Package scripts
   are the project authors' own statement of how to verify it; prefer them over
   ecosystem defaults.
5. **Structure** — workspace/monorepo layout before single-package assumptions.
   A change in a monorepo package may need verification at the workspace root.
6. **Recent history** — the last 15–30 commits show the conventions actually in
   use: commit message style, branch naming, and which areas are active.

## What not to do

- Do not infer a verification command that no file supports. A wrong test
  command produces a confident false negative, which is worse than reporting
  "not detected".
- Do not treat a README as current. Compare it against the code before relying
  on it; production code is authoritative when documentation has gone stale.
- Do not crawl a large repository exhaustively for a profile. The profile is
  bounded on purpose; use targeted search for specifics.

## Leaving a trace

Reconnaissance is expensive and reusable. Record a handoff with the branch,
HEAD, detected verification commands and structure so the next session starts
from established facts rather than repeating the work.
