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

## Research semantics

Semantic repository context is classified as an untrusted `discovery_lead`.
The Agent preserves repository identity, index root, query hash, source snapshot,
parser fidelity, completeness, degradation, source spans, and bounded continuation
state in the durable research checkpoint. It follows a small number of
snapshot-bound pages instead of requesting an unbounded result. A lead is not an
exact source fact, runtime observation, or confirmed vulnerability. The Agent
must use governed exact-source reads and, when authorized, governed runtime
verification before producing a verified conclusion. `exact_source_evidence`,
`runtime_evidence`, `model_inference`, and `unresolved_or_ambiguous` are explicit
classes; incomplete, stale, truncated, degraded, or unresolved evidence keeps a
research task incomplete and is disclosed in synthesis.
