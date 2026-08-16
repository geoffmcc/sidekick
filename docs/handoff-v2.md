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
- `verify` performs that structural validation plus bounded local Git provenance checks.

Validation is structural and evidence-aware metadata is preserved as supplied; it does not
pretend that a referenced commit, file, or URL still exists without a separate verification.

`verify` returns `verified`, `stale`, `unverifiable`, or `invalid`. It only verifies a commit
and branch when `provenance.working_directory` is visible to the Sidekick server. Remote-only
repository URLs are reported as `unverifiable`; the operation never treats metadata as proof.

Evidence, artifact, and relationship entries are also stored as append-only first-class links
with their handoff version, while remaining mirrored in the packet for compatibility.

## Validated resume

The project `resume` record can link to a structured handoff with `handoff_id` or
`handoff_key`. When `resume action="check"` sees a link, it validates the handoff packet
before returning it. Missing or incomplete linked handoffs fail closed with `resume_blocked`
and validation issues. Legacy resume records without a link continue to use the original
behavior.
