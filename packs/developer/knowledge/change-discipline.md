# Change discipline (Developer pack)

## Bounded changes

A change should be describable in one sentence, and the diff should match that
sentence. `dev_change_summary` exists to check exactly that: run it on the
finished change and confirm the affected areas are the ones the intent implies.
Files changed outside the intended area are either scope creep or an
accidental edit; both are worth resolving before review.

## Working-tree hygiene

- Inspect the tree before starting. Unrelated modifications already present are
  the user's work — preserve them, never stash, reset, clean or discard them.
- Verify against the tree you are actually going to hand over. Verification run
  before later edits is stale evidence.
- Inspect the final diff yourself. A diff stat is not a review; read the change.

## Tests

Source changed without any test changed is a signal, not a verdict — some
changes genuinely need no new test. But it should be a deliberate answer, not
an oversight. `dev_change_summary` reports `areas_with_source_but_no_tests` for
this reason: it is a prompt to decide, not an automatic failure.

## What implementation does not include

Implementing a change does not mean committing it, pushing it, opening a pull
request, merging, tagging or publishing. Each of those is a separate governed
operation with its own operator intent. The `developer/implement-change`
workflow deliberately stops at verification and impact analysis.

## Migrations and schema

A migration is the highest-risk kind of change in most repositories because it
is the hardest to reverse. When a change touches migrations:

- confirm the migration is additive where the platform expects additivity;
- confirm any runtime schema path stays in parity with the migration;
- confirm the change is reversible, or state explicitly that it is not.
