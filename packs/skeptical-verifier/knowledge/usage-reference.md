# Skeptical Verifier: inputs and disagreement handling

`independent-check` uses repository profile and semantic index evidence, current
health, and an optional named snapshot. It does not execute project commands,
modify files, mutate services, or treat a successful repository scan as proof of
runtime correctness. Snapshot comparison is useful for drift but is bounded by
the captured sections and collection time.

Interpret profile, semantic, health, and snapshot results independently. A
disagreement is a verification finding or unresolved question, not permission
to choose the favorable result. Record stale, unavailable, partial, and
environment-dependent evidence explicitly, then request a targeted authorized
check when stronger proof is required.
