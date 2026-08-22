# Phase 6 — Filesystem and data security

Baseline for this phase: `c3f5caeb24b0d74e1ba4340acf0fe94f959e04dc` (Phase 5 deployed main).

## Finding F6-01 — archive extraction allowed traversal and implicit process-directory writes

Severity: High. An authenticated caller able to invoke the medium-risk `archive` tool could supply a tar or zip containing `../` or absolute entry names. The previous implementation checked only the archive file and the process working directory, then invoked `tar`/`unzip` without validating entries or accepting a governed destination. A malicious archive could write outside the intended extraction area, including through relative traversal names. The API also silently coupled extraction to the service process working directory.

Fix: archive extraction now lists the complete archive first, rejects NUL, absolute, drive-qualified, and normalized `..` entry paths (including backslash traversal), accepts an explicit extraction destination through the existing `output` field, applies path policy to that destination, creates it deliberately, passes canonical absolute paths to the archive tools, and uses tar ownership/overwrite safety flags. The default destination remains the process working directory for compatibility, but is now explicitly policy-checked.

Regression coverage: `test/security-phase-06-filesystem-data.test.js` tests POSIX, Windows-style, absolute, nested, and backslash traversal names and asserts that extraction performs preflight validation and uses the governed target.

## Filesystem audit evidence

- `src/tools/path-policy.js` is the shared path-policy boundary. It canonicalizes existing components with `realpath`, handles nonexistent write leaves by resolving the deepest existing ancestor, refuses unresolved/dangling symlink components, recognizes platform separators, and applies deny-before-allow matching.
- Direct file/repository tools use `enforcePathPolicy` for read/write/delete operations, including read/write/list/search, media, data extraction, security scans, archive, database paths, backups, watches, changelog paths, and operations repository paths.
- Module and capability-pack installation/packaging use `realpath`/`lstat` checks and reject symlinked package files or entry points. Browser artifact resolution re-checks the real path beneath the data directory before upload.
- Database backup restore verifies regular non-symlink files, resolves the real path beneath the backup directory, bounds the file size, and verifies the checksum before use.
- Archive create now resolves output/source command paths absolutely; archive extract/list pass absolute archive paths; extraction uses an explicit policy-checked target.

## Residual risk

The shared path policy is intentionally open when no allow/deny roots are configured, preserving Sidekick's self-hosted infrastructure capability. Archive preflight and extraction are separate external-tool operations, so a hostile local actor who can replace the archive concurrently could still race the check; the next hardening step would be descriptor-backed archive ingestion or copying the archive into a private, immutable staging file before validation. Archive symlink/hardlink semantics remain a residual tool-format risk and should receive a dedicated parser/staging slice if archive ingestion is exposed to lower-trust users.

Browser downloads, research evidence, module packages, and artifacts remain separate custody surfaces and are not treated as trusted merely because they are stored under Sidekick data directories.
