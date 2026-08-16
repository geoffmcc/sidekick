# Handoff v2

Handoff v2 keeps the existing prose `content` field and adds an optional, versioned `packet`.
Packet changes are preserved in the same append-only history as content changes, so updating
structured state cannot silently overwrite the previous resume state.

## Packet contract

```json
{
  "objective": "What this work is trying to accomplish",
  "summary": "Short current-state summary",
  "status": "active | blocked | ready | completed | abandoned",
  "completed_steps": ["Verified the current implementation"],
  "decisions": ["Keep the existing handoff API compatible"],
  "blockers": [],
  "next_step": "The next concrete action",
  "acceptance_criteria": ["The resume test passes"],
  "risks": [],
  "provenance": {
    "repository": "https://github.com/example/project",
    "branch": "feature/example",
    "commit_sha": "...",
    "working_directory": "...",
    "environment": "...",
    "verification": ["npm test"]
  },
  "evidence": [{ "type": "test", "label": "focused test", "status": "passed" }],
  "artifacts": [{ "type": "file", "path": "src/example.js" }],
  "relationships": [{ "type": "supersedes", "target": "handoff_previous" }]
}
```

The packet is intentionally optional for compatibility with existing handoffs. New handoffs
should provide at least an `objective` or `summary`, a `status`, and a concrete `next_step`.
Blocked packets should explain their blockers; completed packets should include acceptance
criteria.

## Operations

- `create` and `update` accept `packet` alongside the existing prose fields.
- Packet-only updates are versioned and can be guarded with `expected_version`.
- `get` and `versions` return the packet for the selected version.
- `inspect` returns packet validation alongside extracted memories.
- `validate` checks whether a handoff contains enough information to resume safely.

Validation is structural and evidence-aware metadata is preserved as supplied; it does not
pretend that a referenced commit, file, or URL still exists without a separate verification.
