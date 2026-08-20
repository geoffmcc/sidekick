# Releasing Sidekick

This document describes the maintainer release process for Sidekick.

## Release checklist

1. Confirm the release changes are merged to `main` and that CI is green.
2. Bump the authoritative application version in `package.json` and
   `package-lock.json`. Do not change independent capability-pack, protocol,
   helper, or contract versions unless that component is also being released.
3. Create a signed, annotated tag from the exact release commit:

   ```bash
   git tag -s v1.2.0 <release-commit> -m "Sidekick v1.2.0"
   ```

4. Verify the tag locally before pushing it:

   ```bash
   git cat-file -t v1.2.0
   git tag -v v1.2.0
   git show --no-patch --format='%H%n%B' v1.2.0
   ```

   `git cat-file -t` must report `tag`, and `git tag -v` must verify the
   signature. A lightweight tag is not sufficient for a release.

5. Push the verified tag:

   ```bash
   git push origin v1.2.0
   ```

6. Generate the GitHub Release from the existing `v1.2.0` tag. Do not allow
   GitHub to create an unannotated tag as part of release creation.
7. Confirm the GitHub Release references the intended tag and commit, and that
   the tag shows as verified.
8. Update the user-facing installation documentation if the recommended
   pinned version changes.

## Important release invariants

- Never publish a release from a lightweight or unsigned tag.
- Never retarget a published version tag to a different commit.
- The release tag, package version, release notes, and published artifacts
  must identify the same version.
- Release notes must not claim tests, platform support, or artifacts that were
  not actually verified.
- A GitHub Release is created only after the signed tag has been pushed and
  independently verified.

For local MCP installation, a published release can be pinned with:

```json
{
  "mcpServers": {
    "sidekick": {
      "command": "npx",
      "args": ["-y", "github:geoffmcc/sidekick#v1.2.0"]
    }
  }
}
```
