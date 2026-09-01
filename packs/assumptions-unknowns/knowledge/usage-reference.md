# Assumptions and Unknowns: source and resolution guide

The `identify-gaps` workflow reads existing `context`, `memory`, and `handoff`
records, with optional repository or research evidence. Supply a project and
focused query when possible; caller-supplied facts and questions should be
clearly separated from retrieved records. Use the pack to expose assumptions,
unknowns, conflicts, and missing evidence, not to create a second persistence
system.

Treat repository and runtime evidence as newer than stale stored context. An
unknown means the available evidence cannot establish the claim. Resolve one by
collecting attributable evidence or asking an explicit question; do not turn an
absence of a record into a fact. The pack is read-only and does not silently
write memories, handoffs, or project state.
