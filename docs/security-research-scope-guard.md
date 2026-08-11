# Security Research Scope Guard

Phase 7 foundation: versioned authorization snapshots and fail-closed target
evaluation.

Scope snapshots are project-bound, created by an authenticated operator, and
contain an explicit target set, allowed operations, digest, expiry, and
supersession metadata. Target values are runtime data. Reports and guard events
expose target digests and counts only.

An operation is allowed only when the snapshot exists, is active and
unexpired, matches the project, contains the target, and permits the operation.
Every decision records a digest and reason. Only an allowed decision can bind
its snapshot and decision digests to a platform execution. Denials and missing
snapshots fail closed; they never bind an execution.

This contract does not authorize a target by itself, execute a tool, bypass
policy or approval, or claim a finding. The centralized dispatcher and human
approval remain required at the execution boundary.
