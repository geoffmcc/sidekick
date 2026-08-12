"use strict";

// Canonical project identity (Track B slice B3).
//
// Sidekick keys many subsystems on a free-text project string. Two sources of
// that string disagreed on casing/charset: tool boundaries enforce the strict
// lowercase `PROJECT_RE`, while the platform kernel's registry only trimmed —
// so `registerProject("Sidekick")` and `registerProject("sidekick")` forked
// into two canonical identities. This module is the single source of truth for
// both the boundary validator and the canonicalizer, so every writer agrees on
// what one project *is*.
//
// `PROJECT_RE` is the boundary validator (unchanged): explicit `{project}` args
// on tools like `store`/`resume` must already be lowercase snake — it rejects,
// it does not rewrite. `canonicalizeProjectName` is the convergence function
// applied to strings that never passed the boundary (inferred names, legacy
// rows, kernel registration): it lowercases and maps any non-`[a-z0-9_]` run to
// a single underscore, stripping leading/trailing underscores. It does NOT
// enforce `PROJECT_RE` (a canonical id may legitimately start with a digit);
// callers that need boundary validity apply `PROJECT_RE` themselves.

const PROJECT_RE = /^[a-z][a-z0-9_]*$/;

// Mirrors the long-standing inference canonicalization in src/memory.js so a
// name inferred there and a name registered in the kernel resolve to the same
// identity.
function canonicalizeProjectName(name) {
  return String(name == null ? "" : name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

module.exports = { PROJECT_RE, canonicalizeProjectName };
