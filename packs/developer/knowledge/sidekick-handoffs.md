# Handoff expectations for developer work (Developer pack)

Developer work spans sessions. A handoff is what makes the next session start
from established facts instead of re-deriving them.

## Record, at minimum

- **Repository identity** — path, branch, HEAD SHA at the time of the work.
- **Working-tree state** — clean, or exactly what was outstanding.
- **What was established** — the detected verification commands, the structure,
  the root cause, whatever the work actually determined.
- **What was done** — the change, in terms of files and intent.
- **Verification evidence** — the commands run, their exit status, and the
  verdict. Not "tests pass".
- **What was NOT done** — explicitly. Uncommitted work, unpushed branches,
  skipped verification, unresolved questions.
- **Next step** — the single thing the next session should do first.

## Distinguish observed from inferred

A handoff is read later as fact. Mark inference as inference, and attach the
evidence that supports a conclusion, so a stale conclusion can be re-checked
rather than inherited.

## Handoffs are not a substitute for the repository

Repository state, git history and the project's own instruction files are
authoritative. A handoff records what a session learned and decided; when the
two disagree, the repository wins and the handoff is what needs correcting.

## Secrets

Never place credentials, tokens or key material in a handoff, a memory, or a
knowledge entry. Reference the secret by name through Sidekick's secret store
instead.
