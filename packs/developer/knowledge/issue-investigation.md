# Issue investigation (Developer pack)

## Evidence before hypothesis

An investigation produces findings backed by things that were actually
observed: matching code locations, the history that touched them, the current
working-tree state, and, where safe, a reproduction. A plausible narrative with
no evidence behind it is worse than "not yet determined", because it is acted
on with unearned confidence.

## Method

1. **Establish the repository state.** Which branch, which HEAD, is the tree
   clean. An investigation against a dirty tree is an investigation of
   something nobody else has.
2. **Map the reported language onto the code.** Search for the literal symptom
   text first — error strings usually exist verbatim in the source. Then search
   for the domain terms.
3. **Read the implicated code**, not just the matches around it.
4. **Look at history for the implicated files.** A regression usually has a
   commit; a long-standing bug usually does not.
5. **Reproduce only when it is safe.** Reproduction that mutates data, calls a
   third party, or runs a destructive command is not "just investigating".
6. **State the root cause and the affected components**, separating what was
   observed from what is inferred.
7. **Propose a bounded fix.** Investigation ends with a plan, not an edit.

## Do not modify source

Investigation is read-only. If the fix is obvious, record it in the handoff and
let the operator choose the implementation workflow. Silently fixing what you
were asked to investigate removes the operator's decision.
