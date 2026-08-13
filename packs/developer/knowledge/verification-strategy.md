# Verification strategy (Developer pack)

## Use the project's own commands

`dev_verify` selects commands from evidence: package scripts first, then
ecosystem markers, then explicit configuration overrides (which win outright).
Every result reports the command that ran, why it was selected, its exit status
and bounded output — so a verification claim can always be checked.

## Breadth

- `quick` — syntax, lint, typecheck. Fast feedback during iteration.
- `standard` — lint, typecheck, test. The default for a finished change.
- `full` — lint, typecheck, test, build. For release preparation and anything
  that changes build configuration.

Narrow, targeted tests during development; the fuller set once, at the end,
against the final tree. Running a full suite repeatedly against an unchanged
tree is wasted work, not extra assurance.

## Reading a result honestly

- `passed` — every requested intent ran and succeeded.
- `passed_partial` — everything that ran succeeded, but some intent had no
  detectable command. Say which; do not report it as a clean pass.
- `failed` — at least one command exited non-zero. The failure output tail is
  in the result; quote it rather than paraphrasing.
- `blocked` — a command required approval or was refused by policy. Nothing was
  proven either way.
- `nothing_to_verify` — no command could be selected at all. This is a
  detection result, not a pass.

Never report a change as verified on the strength of intent, a zero exit from
an unrelated command, or a script's own success message. Independent evidence
means the actual command, its actual exit status, and its actual output.

## Overrides

When detection is wrong or the repository needs a specific invocation, set the
explicit `test_command` / `lint_command` / `typecheck_command` /
`build_command` configuration. Overrides are reported in the result so the
selection stays transparent.
