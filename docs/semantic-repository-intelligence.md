# Semantic Repository Intelligence

Sidekick's Developer Pack includes a local, static Semantic Repository Intelligence (SRI) index. SRI is an evidence-linked compression layer between source files and model context; it does not replace source files and it does not execute repository code.

## What exists

`semantic_repo` builds, verifies, and queries a versioned `sidekick.semantic-ir.v4` index. `dev_repo_profile` adds a bounded `semantic` section containing languages, modules, entry-point candidates, typed execution relationships, lifecycle/phase evidence, state transitions, continuation evidence, dynamic-capability distinctions, structural security boundaries, limits/warnings, and the deterministic `index_root_hash`. Both tools are low-risk read-only capabilities and use the normal pack descriptor, dispatcher, path policy, redaction, audit, and request context paths.

The index currently parses TypeScript, TSX, JavaScript, JSX, Ruby, Java, Go, Perl, and Rust using pinned Tree-sitter grammar adapters plus conservative lexical signals. Perl additionally extracts package scopes, named and forward subroutines, visible signatures/prototypes, lexical declarations, imports and `require`, static `parent`/`base` inheritance, calls, methods, and anonymous subroutines. Computed receivers, `AUTOLOAD`, `eval`, typeglobs, and runtime symbol-table changes remain `dynamic`, `candidate`, or `unresolved` with a bounded reason. Parser errors or unavailable native grammars produce explicit partial fidelity metadata. These are static structural facts with bounded provenance, not vulnerability findings or a dynamic call graph.

Query progressively with `level=0` for an overview, `level=1` for bounded symbol evidence, and `level=2` for relationships. Retrieval enforces validated item, character, file, relationship, snippet, traversal, and internal-work bounds. Results include counts with quality, `has_more`, applied limits, degradation reasons, and an integrity-protected expiring cursor bound to the query, index root, projection version, ordering, and page size. Invalid, stale, tampered, or mismatched cursors fail closed. Results are explicitly labeled untrusted repository-derived data; source locations are evidence pointers for governed reads.

## Compact projection policy

The full IR is the canonical evidence model; the compact projection is a
deterministic consumer/view for model context. It intentionally compresses
ordinary adapters, pass-through calls, and formatting plumbing, but retains
typed relationships and classified symbols that can change architectural
interpretation. Retention priority is: execution-authority and side-effect
seams; security, authorization, approval, integrity, schema, risk, timeout,
and cancellation boundaries; durable continuation and state transitions;
branch/fallback/error/convergence edges; lifecycle phases; and bounded
provenance. The projection does not copy comments, docstrings, or source
prose.

Governance symbols are emitted in source-evidence order with their structured
boundary categories, phase, side-effect classes, and evidence location. A
fallback remains a typed fallback edge rather than becoming a sequential call.
Persisted continuation and waiting/runnable state remain separate from later
resume and dispatch edges, so approval is not represented as synchronous
execution. Meaningful convergence and execution seams remain visible even
when surrounding adapters are pruned.

Budget degradation is deterministic and progressive: large views retain
detailed relationship provenance, moderate views retain grouped categories and
ordered governance symbols, and tight views remove ordinary decoration first.
Every projection carries a machine-readable `degradation` object describing
whether it was truncated, the degradation level, omitted categories, and
provenance/security detail. Security/control-flow edges receive preferential
retention, but omission is never represented as absence. An `impossible`
projection explicitly reports `minimum_semantics: "unrepresentable"` when the
requested budget cannot carry the minimum metadata. Serialization remains
valid JSON. Stable semantic sorting and tie-breaking ensure identical IR plus
configuration produces identical output. Projection options do not alter the
IR or its content hash. These guarantees improve structural fidelity but do
not constitute complete semantic reconstruction or prove runtime behavior
that static analysis did not observe.

## Snapshot-Bound Source Analysis

Security Research can invoke SRI through a registered source repository and
snapshot rather than accepting an arbitrary analysis path. The source manager
resolves the campaign/project-owned IDs, verifies the immutable snapshot, and
passes only its registered external directory to `semantic_repo`. The result
must carry the same snapshot-bound repository identity and matching
`index_root_hash`; otherwise the operation fails closed. Index provenance
includes the source snapshot ID and content hash.

The storage model is campaign-centered:

```text
<external-workspace>/projects/<campaign_id>/repositories/<repository_id>/<snapshot_id>/
```

The logical repository record is not an authority boundary and the directory
is not a second source-of-truth repository. Snapshot content is always
`derived_analysis_input`. Selection chooses the current analysis input for a
campaign-owned source repository but does not promote it. `refresh` creates a
new immutable snapshot. Verification detects modified, missing, or incomplete
storage; stale snapshots cannot be indexed or selected. Source `acquire` uses
the canonical structured HTTPS-only Git clone operation, while authenticated
acquisition remains disabled until secret-reference injection can be kept out
of arguments, URLs, logs, and model context.

The shared evidence classes from PR #554 apply to SRI results: semantic
matches are `discovery_lead`; exact governed reads can provide
`exact_source_evidence`; probe results provide `runtime_evidence`; model
interpretations are `model_inference`; and incomplete, stale, degraded, or
conflicting results are `unresolved_or_ambiguous`. SRI cannot turn a discovery
lead into proof, grant authorization, or replace exact source/runtime evidence.

## Integrity and lifecycle

Each analyzed file has a domain-separated SHA-256 source identity and a normalized semantic unit identity. Symbols have deterministic scoped `id` values derived from repository-relative path, package/lexical parent, kind, name, and a canonical duplicate occurrence. Display names remain for readability; relationships use `from_id`/`to_id` when uniquely resolvable and bounded candidate ID arrays when a name is genuinely ambiguous. Every source span carries its relative path, source hash, line/column, and byte start/end. Result provenance records repository identity, index root, source snapshot, parser versions, query hash, execution time, completeness, degradation, and evidence class. Schema v4 uses a new hash domain; older cache/index meanings are never silently reinterpreted. These hashes provide content integrity, not authorship or authentication.

The cache is outside the repository in Sidekick's OS temporary data area, is keyed by the resolved repository path, is written with restrictive permissions, and is disposable. The process retains only a small bounded in-memory LRU and prunes the disk cache to a bounded set of recent entries; disk cache entries remain advisory and are integrity-checked before reuse. Every invocation rescans bounded file metadata/content identities. A cache unit is reused only when its source hash, IR version, and analyzer version match; changed, added, removed, unsupported, binary, oversized, and symlinked files cannot silently become stale. Cache failure causes a safe reparse, not a failed profile.

Parsing uses pinned Tree-sitter grammars for TypeScript/TSX, JavaScript/JSX, Ruby, Java, Go, Perl, and Rust. Adapters expose parser metadata and normalize symbols, imports, exports, and statically observed calls into the versioned IR. Parser errors remain visible in the unit and do not invalidate unrelated files; the index never executes repository code. Native parser packages are installed as locked runtime dependencies and are not a requirement for the target language runtimes themselves. The repository `.npmrc` narrowly records `legacy-peer-deps=true` because the maintained Java and Ruby grammar packages publish optional peers for the older 0.21 runtime while the JavaScript/Go grammars require 0.25; the pinned set is tested together in CI.

Each file has both a raw `source_hash` and a normalized `semantic_hash`. The source identity changes for any byte change; the semantic identity is computed from normalized structure and relationships without locations or raw literal values, so formatting-only changes can remain semantically stable when the parser establishes the same structure. Repository `index_root_hash` covers the canonical persisted representation and is an integrity/content identity, not an authorship signature.

For a registered Security Research snapshot, the snapshot manifest/content hash
and the SRI index root are separate integrity identities. A matching hash does
not prove authorship, safety, authorization, or runtime behavior. SRI's
snapshot binding prevents analyzing an unregistered path under a registered
ID; it does not make repository text trusted or permit the text to issue
instructions.

`dev_change_summary base=<ref>` reads the requested Git revision through the governed read-only Git object path and compares that snapshot with the actual requested current state: the working tree by default or the staged index when `staged=true`. It never checks out or executes historical source. Semantic queries expose bounded added, removed, and changed file/symbol information plus relationship-aware caller/callee/import neighborhoods. Relevant Agent requests can contribute a small `repository_semantic` context source through declarative canonical capability metadata, the existing governed tool dispatcher, and Brain/context ranking pipeline. A provider may declaratively identify a request-scope argument; the generic broker extracts an explicit absolute repository path and passes it to the provider, while omitting it preserves the tool's documented current-repository default. Repository-derived content is explicitly untrusted data and is never treated as Sidekick instructions.

## Safety limits and trust model

Defaults bound the walk to 4,000 files, 64 MiB, 512 KiB per file, and directory entries, with a semantic-unit cap. Traversal does not follow symlinks, special files, skipped dependency/generated directories, or paths outside the canonicalized, already-authorized Developer Pack repository root. Malformed/unreadable files are isolated as warnings. Source comments, strings, filenames, and documentation are untrusted data and cannot grant Sidekick authority or alter policy. Function signatures retain bounded parameter names, not default values or raw parameter literals; sensitive literal contents are not retained in the IR.

These SRI analysis limits are distinct from Security Research source import
limits. Source import/refresh rejects a tree above 10,000 files, 100 MiB,
depth 32, or 4,096-byte relative paths before it becomes a registered
snapshot. Both layers fail closed on their own limit violations; neither
silently truncates a registered source snapshot into an authoritative record.

This is static structural analysis. A semantic match is a `discovery_lead`, not authoritative proof. Shared evidence classes distinguish discovery leads, exact source evidence, runtime evidence, model inference, and unresolved/ambiguous evidence. Partial, stale, truncated, degraded, or conflicting evidence cannot satisfy authoritative completion. A continuation marker requires both durable-operation vocabulary and asynchronous/event structure; it does not assert a particular scheduler or runtime protocol. Security classifications require bounded identifier/body patterns and carry confidence plus rule provenance; ambiguous code remains unknown. Exact source inspection remains available through governed filesystem tools.

## Adding a language

Add a supported extension to the bounded discovery map and a real parser branch in `semantic.js` that emits normalized modules/imports/exports/symbols/relationships/signals with evidence. Add a realistic fixture and determinism, malformed-input, secret-safety, and projection assertions. Update this document only after the adapter and tests are present. Do not register an unsupported language or use filename recognition as a parser.

## Troubleshooting

`warnings` and `stats` distinguish truncation, unavailable files, binary files, encoding failures, and semantic-unit limits. `semantic_repo action=verify` recomputes the canonical aggregate hash from the returned index. A failed verification means the cached/indexed record was modified or is incompatible; rerun the profile to rebuild it. A partial index remains useful but must be treated as partial because `stats.truncated` or warnings are retained in the profile. Natural-language repository questions can use the registered repository context provider without naming `semantic_repo`: capability discovery selects the governed inspection tool, the semantic projection is used first, and targeted governed source reads remain available when ambiguity or exact source verification requires them. This is bounded static analysis, not complete code understanding; unsupported or weakly inferred semantics remain explicit as unknown or omitted.

When SRI is used through Security Research, `verify` must pass immediately
before indexing. A later filesystem change makes the registered snapshot stale;
the safe response is to import/refresh a new snapshot and analyze that new
identity. The external workspace and kernel records are separate recovery
assets, so backup and rollback must preserve both when reproducibility matters.
