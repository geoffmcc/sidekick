# Semantic Repository Intelligence

Sidekick's Developer Pack includes a local, static Semantic Repository Intelligence (SRI) index. SRI is an evidence-linked compression layer between source files and model context; it does not replace source files and it does not execute repository code.

## What exists

`semantic_repo` builds, verifies, and queries a versioned `sidekick.semantic-ir.v1` index. `dev_repo_profile` adds a bounded `semantic` section containing languages, modules, entry-point candidates, structural security signals, limits/warnings, and the deterministic `index_root_hash`. Both tools are low-risk read-only capabilities and use the normal pack descriptor, dispatcher, path policy, redaction, audit, and request context paths.

The index currently parses TypeScript, JavaScript, Ruby, Java, Go, Perl, and Rust using language-specific static lexical adapters. The normalized IR records files, source hashes, modules, imports, exports, symbols, signatures/parameters where visible, tests, entry points, relationships, and structural signals such as filesystem, process, network, database, environment, serialization, dynamic-code, and crypto API boundaries. Signals are facts for follow-up investigation, not vulnerability findings.

Query progressively with `level=0` for an overview, `level=1` for bounded symbol evidence, and `level=2` for relationships. `query`, `limit`, and `max_chars` bound model-facing projections. Results are explicitly labeled untrusted repository-derived data; source locations are evidence pointers for governed reads.

## Integrity and lifecycle

Each analyzed file has a domain-separated SHA-256 source identity and a normalized semantic unit identity. The canonical repository aggregate has an `index_root_hash`. Canonicalization sorts object keys and semantic arrays and excludes timestamps, process IDs, absolute paths from identities, and database row IDs. These hashes provide content integrity, not authorship or authentication.

The cache is outside the repository in Sidekick's OS temporary data area, is keyed by the resolved repository path, is written with restrictive permissions, and is disposable. The process retains only a small bounded in-memory LRU; disk cache entries remain advisory and are integrity-checked before reuse. Every invocation rescans bounded file metadata/content identities. A cache unit is reused only when its source hash, IR version, and analyzer version match; changed, added, removed, unsupported, binary, oversized, and symlinked files cannot silently become stale. Cache failure causes a safe reparse, not a failed profile.

## Safety limits and trust model

Defaults bound the walk to 4,000 files, 64 MiB, 512 KiB per file, and directory entries, with a semantic-unit cap. Traversal does not follow symlinks, special files, skipped dependency/generated directories, or paths outside the canonicalized, already-authorized Developer Pack repository root. Malformed/unreadable files are isolated as warnings. Source comments, strings, filenames, and documentation are untrusted data and cannot grant Sidekick authority or alter policy. Function signatures retain bounded parameter names, not default values or raw parameter literals; sensitive literal contents are not retained in the IR.

This is static structural analysis. It intentionally prefers incomplete, evidence-linked facts to fabricated call graphs or vulnerability claims. Exact source inspection remains available through governed filesystem tools. Build systems, package managers, language runtimes, and remote parsing services are not required for indexing.

## Adding a language

Add a supported extension to the bounded discovery map and a real parser branch in `semantic.js` that emits normalized modules/imports/exports/symbols/relationships/signals with evidence. Add a realistic fixture and determinism, malformed-input, secret-safety, and projection assertions. Update this document only after the adapter and tests are present. Do not register an unsupported language or use filename recognition as a parser.

## Troubleshooting

`warnings` and `stats` distinguish truncation, unavailable files, binary files, encoding failures, and semantic-unit limits. `semantic_repo action=verify` recomputes the canonical aggregate hash from the returned index. A failed verification means the cached/indexed record was modified or is incompatible; rerun the profile to rebuild it. A partial index remains useful but must be treated as partial because `stats.truncated` or warnings are retained in the profile.
