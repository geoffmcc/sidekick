# CI failure triage (Developer pack)

## The question is: code, or environment?

A CI failure is only actionable once you can say which. The `developer/ci-triage`
workflow gathers both halves of the comparison — the remote check state and a
local run of the same verification — so the answer rests on evidence.

## Reading the comparison

| Local | CI | Most likely |
|---|---|---|
| fails the same way | fails | the code. Fix the code. |
| passes | fails | environment, dependency resolution, cache, platform, or timing |
| fails differently | fails | local tree differs from what CI built — check for uncommitted work |
| not run / blocked | fails | nothing is established yet; say so |

Before concluding "flake", check the cheaper explanations first: the local tree
is dirty, the branch is behind the base, a lockfile changed, a secret or
service is unavailable in CI, or the job timed out under load.

## Distinguishing failure classes

- **Compilation/typecheck** — deterministic; almost always the code.
- **Test assertion** — usually the code; occasionally an order-dependent or
  time-dependent test.
- **Timeout** — infrastructure or a genuine performance regression. The diff
  tells you which is plausible.
- **Dependency resolution / install** — environment or a lockfile change.
- **Missing credential or service** — infrastructure. Not a code fix.

## Report the evidence

Cite the failing check name, the exit status, and the specific output lines
that show the failure. A diagnosis without the line that produced it cannot be
checked by the person who has to act on it.
