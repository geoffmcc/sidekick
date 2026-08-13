# Pull request review (Developer pack)

## Ground every finding

A review comment must point at something in the diff. `dev_change_summary`
supplies the structured basis: per-file classification, affected areas, API
surface changes with the symbol names, dependency version movements, migrations,
and coverage signals. Findings that cannot be tied to a file and a reason are
filler and should not be written.

## What to look at, in order

1. **Correctness** — does the change do what it says for the inputs it will
   actually receive, including the boundaries?
2. **Regressions** — what previously worked that this could break. Removed
   public symbols (`api_surface.potentially_breaking`) are the first place to
   look.
3. **API and schema behaviour** — signature changes, response shape changes,
   migrations. These are the changes other people's code depends on.
4. **Error handling** — failure paths, not just the happy path. Swallowed
   errors and failures that report success are the expensive ones.
5. **Security** — authentication, authorization, secrets, path handling,
   command construction, untrusted input. Changes under security-sensitive
   paths are flagged in the risk list.
6. **Concurrency and state** — shared state, ordering assumptions, retries,
   idempotency, and anything that changes across processes.
7. **Compatibility** — old data, old clients, rolling deployment.
8. **Tests** — do they test the behaviour that changed, or only that the code
   runs?
9. **Documentation** — does the change make existing documentation wrong?
10. **Maintainability** — only after the above, and only where it matters.

## Verification is part of review

Run the project's own verification and report the verdict as evidence. A review
that says "looks good" without having run anything has established less than it
appears to.

## Tone and scope

Say what is wrong, where, and why it matters. Do not pad a review with generic
observations to look thorough — an empty findings list from a real inspection is
a legitimate and useful result.
