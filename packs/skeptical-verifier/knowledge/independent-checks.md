# Skeptical Verification

The `skeptical_verify` tool is deliberately independent of project verification. It reads a repository profile, verifies the semantic index, checks platform health, and can compare an already-existing snapshot. It never runs a project command, captures a new snapshot, changes memory, or writes a handoff.

Its verdict is evidence collection, not proof of correctness. A model or operator must interpret mismatches and preserve the evidence and limitations.
