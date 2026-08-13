# Dependency upgrades and release preparation (Developer pack)

## Dependency upgrades

Keep the scope to what was asked. A request to upgrade one package is not
permission to refresh the lockfile wholesale — a wide dependency sweep hides
the one change anyone wanted to review, and makes a later bisect much harder.

Sequence that keeps it bounded:

1. Establish the currently declared version and the manager in use.
2. Find every usage site that an upgrade could break, before changing anything.
3. Read the target version's breaking changes where a major version moves.
4. Apply the update through the project's own package manager, with the exact
   command — never by hand-editing a lockfile.
5. Confirm from the resulting diff that only the dependency manifests moved.
6. Verify, and report what remains uncertain.

The `developer/dependency-upgrade` workflow requires the update command
explicitly, so the workflow never invents a mutation of the dependency tree.

## Release preparation

Preparation establishes readiness and drafts artifacts. It does not release.

Readiness means all of:

- the working tree is clean, so the release corresponds to a real commit;
- verification passes on that tree;
- the intended version matches the project manifest;
- the changelog covers this version;
- every breaking API change and every migration in the range is deliberate and
  documented.

Anything unmet is a blocker to state plainly, not a caveat to bury.

## Publication stays with the operator

Creating a tag, creating a GitHub release, and publishing a package are
irreversible and outward-facing. They are separate governed operations, and
they require explicit operator intent — a green readiness verdict is not that
intent.
