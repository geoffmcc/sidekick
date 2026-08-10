# Encrypted Workspace Secret References

Status: design (Phase 3 / Track B of the platform convergence roadmap)
Tracking: `docs/platform-convergence-audit.md` — unresolved decision #5
Depends on: `src/core/secret-cipher.js`, `src/platform/kernel-schema.js`, migration `027_platform_project_projection.sql`

## Problem

`platform_project_workspaces.secrets_json` stores workspace secrets as
plaintext JSON at the kernel boundary. Any reader of the database (backups,
exports, snapshots, dashboard SQL) can recover secret values. Existing
deployments already store secrets this way, so the fix must not break them.

## Design

### Storage: additive child table

Migration `027` creates a child table alongside the legacy plaintext column:

```sql
CREATE TABLE IF NOT EXISTS platform_workspace_secrets (
  workspace_id TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, secret_name),
  FOREIGN KEY(workspace_id) REFERENCES platform_project_workspaces(workspace_id)
);
```

- `secrets_json` (plaintext) is retained unchanged for backward
  compatibility. New writers stop populating it; readers fall back to it only
  for legacy rows that predate the encrypted store.
- Each row stores one secret's `secret-cipher` envelope in `envelope_json`:

  ```json
  { "iv": "...", "data": "...", "authTag": "..." }
  ```

  The value is `encryptSecret(value)`, produced by
  `src/core/secret-cipher.js`. The composite primary key keeps per-secret rows
  isolated and provides an index for `workspace_id` lookups with no extra
  index object.

- The table is created with `CREATE TABLE IF NOT EXISTS` in both the
  migration and `kernel-schema.js`, so both boot paths (migrations-only and
  runtime-kernel-only) produce byte-identical `sqlite_master` text. A child
  table was chosen over `ALTER TABLE ... ADD COLUMN` because SQLite has no
  `ADD COLUMN IF NOT EXISTS`, so a column migration could never be idempotent
  when the runtime kernel schema and migrations both run on one database. The
  parity test normalizes whitespace around `, ( )` so future additive ALTER
  migrations cannot introduce comparison noise.

### Cipher

`src/core/secret-cipher.js`:

- AES-256-GCM, key = SHA-256 of `SIDEKICK_SECRET_KEY` from the environment.
- `encryptSecret` returns `{ iv, data, authTag }`; `decryptSecret` inverts it.
- Absent key throws (`getSecretKey`) — callers fail closed. The kernel guards
  with `hasSecretKey()` to raise a clear, consistent error before any write.
- Random IV per write, so identical values produce different ciphertext.

### Kernel API

New workspace methods on `src/platform/kernel.js` (all exported):

| Method | Behavior |
| --- | --- |
| `setWorkspaceSecret(workspaceId, name, value, details?)` | Encrypt and upsert a row; emits `workspace.secret_set`. Throws if key absent. |
| `getWorkspaceSecret(workspaceId, name)` | Decrypt and return; `null` for unknown workspace/name. Throws if key absent. |
| `deleteWorkspaceSecret(workspaceId, name, details?)` | Remove one row; `{ deleted: true \| false }`; emits `workspace.secret_deleted`. |
| `listWorkspaceSecretNames(workspaceId)` | Sorted names, no values, no key required. |

Getters `getProjectWorkspace` / `getWorkspaceByProject` attach
`secret_names` (sorted, from the child table; no key required). The child
table lives entirely behind the kernel, so raw ciphertext never appears on a
workspace row and never leaks into caller logs or responses. Legacy `secrets`
(plaintext) and `config` / `resource_limits` / `metadata` parsing are
unchanged — `test/workspace-model.test.js` (WS.1/WS.2) assertions are
unaffected.

### Fail-closed guarantee

- Without `SIDEKICK_SECRET_KEY`, `setWorkspaceSecret` and
  `getWorkspaceSecret` throw rather than degrade to plaintext.
- `listWorkspaceSecretNames` and the getter normalization do not require the
  key (names are not secret material), matching the existing behavior of
  `hasSecretKey`/`encryptColumn`.

## Migration / rollout

- `CREATE TABLE IF NOT EXISTS` is additive and idempotent; existing rows keep
  `secrets_json` and simply have no encrypted rows yet. No data migration is
  required for availability.
- A follow-up (outside this design) can backfill: for each secret in a
  workspace's legacy `secrets_json`, write it through `setWorkspaceSecret`,
  then clear `secrets_json` once all deployments have rotated.

## Tests

`test/project-identity.test.js`:

- PI.11 ciphertext at rest contains the envelope but never the plaintext
  (queries `platform_workspace_secrets.envelope_json`).
- PI.12 round-trip, missing name → `null`, missing workspace → `null`.
- PI.13 delete, re-delete, and name listing.
- PI.14 fail-closed without `SIDEKICK_SECRET_KEY`.
- PI.15 getters expose `secret_names` and never raw ciphertext.

`test/kernel-migration-parity.test.js` (KMP.1–KMP.4) verifies migration
`027` is applied, both boot paths produce identical `platform_*` DDL (17
tables / 38 indexes), and the kernel schema module stays in sync.

## Non-goals

- No encryption key rotation scheme (out of scope; `secret-cipher` key is
  environment-scoped).
- No automatic plaintext purge during this migration.
- No per-user secret access control (no users/teams model in Phase 3).
