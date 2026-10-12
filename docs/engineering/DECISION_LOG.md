# Decision log

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

- Preserve baseline and latest security fixes; no dependency changes.
- Use a dedicated branch in the original checkout; execute tests in a tracked-source export without .env or operational data, using installed dependencies read-only through NODE_PATH.
- Do not invoke connected live Sidekick tools: the request excludes production-resource access and live mutation. Repository guidance for live session writes is subordinate to that constraint. Durable campaign state is local engineering documentation.
- Reuse existing handoff tables and public APIs. Existing v3 architecture makes a new database or event bus unnecessary.
- Report test cleanup failures as failures even if behavioral assertions pass.
- Keep unsupported areas explicit. Inventory coverage is not a complete security audit or proof of production readiness.


## Final decisions

- Hash bounded staged and unstaged Git diffs separately. Preserve exact porcelain whitespace. Do not persist raw diff text.
- Prefer explicit blocking to falsely validating untracked or changed submodule contents. Capture legacy data without silently inventing hashes; require reconciliation for legacy dirty state.
- Use one existing SQLite transaction for checkpoint row and event. Do not claim filesystem atomicity or power-loss guarantees.
- Recheck evidence time on read and require a matching stored check for every packet item. Fresh timestamps cannot upgrade invalid prior verification.
- Keep schema versions/public APIs and dependencies unchanged. No database migration or service restart required by the patch itself. Rolling back code restores the earlier, weaker readiness behavior; old consumers ignore additive fingerprint fields.
- Final code review performed locally; no delegated agents or live Sidekick session writes.
- A leftover fixture directory from the aborted broad run was ignored only in the disposable validation repository's .git/info/exclude. The actual repository ignore rules were unchanged. One intermediate handoff-versioning run failed closed due to that untracked fixture; it passed after isolating the unrelated artifact.
- Original repository commits used its existing Git configuration. Only disposable fixture commits override signing; no credential or signing-key access was requested.
