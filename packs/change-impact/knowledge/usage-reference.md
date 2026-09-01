# Change Impact: inputs and evidence limits

The `blast-radius` workflow combines `dev_change_summary` with
`semantic_repo`. Use a working-tree diff by default, set `staged` when the
index is the subject, or provide a `base` ref for a bounded comparison. The
configured `max_files` and tool output bounds limit what is analyzed.

The result classifies source, tests, documentation, configuration, migrations,
dependencies, and CI changes, then reports repository-evidenced affected areas,
symbols, and risk signals. Semantic relationships and inferred runtime impact
are incomplete when indexing is bounded or code is generated dynamically. This
pack is read-only: its predictions require verification and do not authorize a
deployment, migration, commit, or rollback.
