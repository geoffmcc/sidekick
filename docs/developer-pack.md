# Developer / Software Engineering Pack

Status: shipped (v1.0.1), bundled first-party
Package: `packs/developer/`

> Make Sidekick substantially better at understanding, investigating,
> modifying, verifying and maintaining software projects.

The Developer pack is the first-party consumer that proves the Capability Packs
platform. It contributes one module (four tools), seven runnable workflows and
ten knowledge assets, and it is installed, enabled, configured, upgraded and
uninstalled through exactly the same lifecycle a third-party pack uses.

## Install

```
capability action="install" name="developer"
capability action="enable"  name="developer"
capability action="health"  name="developer"
```

Or Dashboard → **Capabilities** → Developer / Software Engineering → Install →
Enable. No configuration is required for the pack to be useful on a normal
repository.

## Tools

All four are contributed by the `developer-tools` module and dispatch through
the canonical registry, so they inherit schema validation, tool policy,
approvals, timeouts, redaction and audit logging.

### `dev_repo_profile` (risk `low`, alias `repo_profile`)

A structured, **mechanically derived** software-project profile. Nothing is
inferred by a language model; a fact that cannot be established from files on
disk is reported as absent rather than invented.

| Argument | Meaning |
|---|---|
| `path` | repository path (default: the Sidekick working directory) |
| `max_files` | bound on the file scan (default 4000) |
| `include_git` | include git facts (default true) |

Returns: repository root, branch, upstream, ahead/behind, HEAD (sha, subject,
author, date), working-tree state with per-file status, remotes, branches,
recent commits; top-level layout, file count, workspace/monorepo detection;
languages by file count; ecosystems and their manifests; package managers with
their install commands; classified build/test/lint/typecheck scripts; CI
provider and config files; container files; migration directories and counts;
documentation; agent instruction files (`AGENTS.md`, `CLAUDE.md`, …); and
candidate verification commands, **each with the evidence that produced it**.

Git facts are read through Sidekick's `git` tool, not by shelling out.

### `semantic_repo` (risk `low`)

Builds and queries a deterministic, hash-verifiable semantic repository index
without executing repository code. Use `action="profile"`, `action="query"`,
or `action="verify"`; queries are bounded by `level`, `limit`, `max_chars`, and
an optional continuation cursor.

### `dev_change_summary` (risk `low`, alias `change_summary`)

Structured engineering impact for a change set.

| Argument | Meaning |
|---|---|
| `path` | repository path |
| `base` | compare against this ref (e.g. `origin/main`); omit for working-tree changes |
| `staged` | analyze staged changes instead of unstaged |
| `max_diff_chars` | bound on diff text analyzed (default 400000) |

Returns: totals (files, insertions, deletions, churn, binary files);
per-kind classification (source, test, documentation, configuration,
migration, dependency, CI, other) with counts, line movement and file lists;
affected areas ranked by churn; likely public API/schema changes with the
**symbol names** added and removed and which are potentially breaking;
dependency version movements (`from` → `to` → `change`); verification coverage
signals; evidence-backed risk indicators with a severity and an overall risk
level; explicitly listed **untracked files**, which no diff can show; and the
raw per-file numbers the analysis was computed from.

The result **pins what was analyzed**: `git_state` carries `head_sha`,
`branch`, `worktree_clean` and `changed_file_count`, and `scope.base_sha`
resolves the base ref to the exact commit — "diff against origin/main" is not
reproducible once that ref moves, but "diff against `<sha>`" is.

### `dev_verify` (risk `high`, alias `verify_project`)

Governed verification: selects the project's own commands and runs them through
Sidekick's `bash` tool. The pack never spawns a process itself.

| Argument | Meaning |
|---|---|
| `path` | repository path |
| `mode` | `quick` (syntax, lint, typecheck), `standard` (lint, typecheck, test), `full` (adds build) |
| `intents` | explicit intents, overriding `mode` |
| `continue_on_failure` | keep running after a failure (default false) |
| `max_output_chars` | bound on retained output |
| `timeout_ms` | per-command timeout |

Selection order: explicit configuration override → package script → ecosystem
default with a marker file present → **`not_detected`**. Nothing is invented.
The ecosystem TypeScript default is `npx --no-install tsc --noEmit`: a
verification command must never install a package or reach the network to
decide whether a project typechecks.

For every intent the result reports the selected command, why it was selected,
the exact command executed, exit status, duration and bounded output (tail
preserved — runners put the summary at the end). The result also pins the code
it verified: `git_state` carries `head_sha`, `branch`, `worktree_clean` and
`changed_file_count`, so a verdict can always be tied to the exact tree state
it ran against.

| Verdict | Meaning |
|---|---|
| `passed` | every requested intent ran and succeeded |
| `passed_partial` | everything that ran succeeded; some intent had no detectable command |
| `failed` | at least one command exited non-zero |
| `blocked` | a command required approval or was refused by policy — nothing proven |
| `nothing_to_verify` | no command could be selected at all |

## Workflows

All are registered in Sidekick's workflow definition registry and runnable with
`workflow action="run"`.

| Workflow | Mode | Purpose |
|---|---|---|
| `developer/repository-recon` | read-only | Understand an unfamiliar repository before modifying it; leaves a durable handoff |
| `developer/issue-investigation` | read-only | Investigate a GitHub issue or a described bug and produce evidence-backed findings; never modifies source |
| `developer/implement-change` | mutating | Take a bounded change through verification, final diff and impact analysis; never commits, pushes, merges or releases |
| `developer/ci-triage` | read-only | Explain a CI failure by correlating remote check state with a local reproduction |
| `developer/pull-request-review` | read-only | Substantive engineering review grounded in the actual diff and an executed verification |
| `developer/dependency-upgrade` | mutating | Bounded upgrade of ONE dependency, with the update command supplied explicitly |
| `developer/release-preparation` | read-only | Readiness verdict and a release-notes draft; never tags, releases or publishes |

Two deliberate boundaries:

- **Investigation does not modify source.** If the fix is obvious it goes in the
  handoff; choosing to implement it is the operator's decision.
- **Implementation does not publish.** Commit, push, merge, tag, release and
  package publication remain separate governed operations requiring explicit
  operator intent. `developer/dependency-upgrade` additionally requires the
  operator to supply the exact update command, so the workflow never invents a
  mutation of the dependency tree.

## Knowledge

Ten entries in the `development` category, tagged `pack:developer`,
searchable through the ordinary `knowledge` tool: repository reconnaissance,
change discipline, verification strategy, issue investigation, CI triage, pull
request review, dependency upgrades and release preparation, and handoff
expectations.

These are operational guidance, not programming tutorials. **Repository-specific
instructions such as `AGENTS.md` remain authoritative for that repository**;
pack knowledge complements them and never overrides them.

## Configuration

Validated against the pack's JSON Schema and propagated to the
`developer-tools` module (`config_from_pack: true`). Safe defaults; none of it
is required.

| Setting | Default | Meaning |
|---|---|---|
| `autodetect_verification` | `true` | Detect verification commands from project files. When false, only explicit overrides run. |
| `verification_mode` | `standard` | Default breadth for `dev_verify` |
| `test_command` | — | Explicit test command, overriding detection |
| `lint_command` | — | Explicit lint command |
| `typecheck_command` | — | Explicit typecheck command |
| `build_command` | — | Explicit build command |
| `syntax_command` | — | Explicit syntax-check command |
| `max_output_chars` | `12000` | Retained output per command (max 60000) |
| `command_timeout_ms` | — | Per-command timeout |
| `continue_on_failure` | `false` | Keep running after a failed command |
| `repository_roots` | `[]` | Confinement: when non-empty, the Developer tools refuse paths outside these roots, **in addition to** the global Sidekick path policy |

Example:

```
capability action="configure" name="developer" config={
  "verification_mode": "full",
  "test_command": "npm run test:ci",
  "repository_roots": ["/srv/repos"]
}
```

**Secrets do not belong here.** GitHub credentials come from Sidekick's secret
store (`github_token`) through the `github` tool.

## Dependencies

| Required | Why |
|---|---|
| `git` | every repository fact |
| `bash` | verification command execution |
| `read`, `list`, `search` | workflow file and code inspection |

| Optional | Degrades to |
|---|---|
| `github` | issue/PR enrichment steps are skipped |
| `ci_status` | CI triage runs on local evidence only |
| `handoff` | no durable handoff is recorded |
| `project` | no canonical project context is attached |
| `changelog` | no release-notes draft |
| `summarize`, `depend` | those enrichment steps are skipped |

Optional tools that are unavailable are reported by pack health; they never
fail a workflow, because every step that depends on one is conditional or
tolerates failure.

## Health

`developer-tools` reports healthy when its libraries load and any configured
`repository_roots` exist; a configured root that does not exist is an unhealthy
module and therefore an unhealthy pack. Pack health additionally covers
compatibility, configuration validity, workflow definition registration,
knowledge row state, and required/optional tool availability — and the owned
module's whole-package integrity, so a mutated installation shows as
`integrity_failure` at the pack level.

## Security notes specific to this pack

- `dev_verify` is `high` risk and dispatches `bash`, which is `critical`. The
  module declares that permission explicitly and the dispatcher's approval path
  applies; where approvals are enabled, a verification command parks for
  approval rather than running.
- Every path the pack touches passes through the shared Sidekick path policy
  via the module services facade — the same boundary the built-in filesystem
  family uses. `repository_roots` is an *additional* confinement, not a
  replacement for it.
- `dev_verify` reports the exact command it executed, so a verification claim
  can always be checked against what actually ran.
