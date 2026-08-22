# Agent evidence projection

Sidekick keeps the authoritative result returned by the governed dispatcher
separate from the bounded representation placed in an Agent model prompt.
`src/evidence/projector.js` performs the latter operation after dispatch and
redaction.

Structured results are traversed deterministically with per-sibling budgets,
bounded depth, array/item limits, cycle protection, explicit omission markers,
and a shared per-task budget. Object property order therefore cannot make a
later section invisible. Source-order arrays remain source ordered. Large
plain text retains bounded beginning and ending portions.

The normal Agent loop and Brain use the same projection behavior. Multiple tool
results are reprojected into one aggregate evidence block so one verbose tool
cannot consume the task's entire model-facing evidence budget. The current
hard ceilings are 4,000 characters per tool result and 16,000 characters for
aggregate tool evidence; context entries use an 1,800-character per-entry
ceiling and an 18,000-character aggregate ceiling. These are conservative
character bounds, using an
approximate four-characters-per-token planning ratio rather than claiming
tokenizer precision.

Context Engine entries are presented with source/type provenance, trust
metadata when available, both summary and content, and a bounded aggregate
context budget. Meaningful content is not discarded merely because an entry
also has a summary.

Projection is model-facing only. Tool execution, policy, approval, audit,
redaction, repository scope, and authoritative evidence storage remain on the
existing governed paths. Repository and capability output remains untrusted
data and is explicitly labeled as such in model-facing prompts.
