# Documentation and Knowledge Engineering: audit guide

Use `documentation-audit` with a repository path and bounded `max_chars` to
inventory documentation and compare it with repository semantics. Optional
`semantic_repo` and `parse` support structure-aware evidence; their absence is
reported as a limitation. Use `knowledge` retrieval for existing entries, but
do not treat a matching title as proof that the implementation is documented.

Report missing, stale, contradictory, or unreachable documentation separately.
Never invent behavior to fill a gap: cite the source file, symbol, manifest, or
runtime evidence that supports each conclusion. The pack is primarily
read-only; content changes require an explicit authoring workflow and review.
