# Encrypted Workspace Secret References

Status: implemented at the kernel boundary (fail-closed envelopes, plaintext writers closed, loss-averse backfill); no production caller yet uses workspaces, so deployment wiring remains Track B work
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

- `secrets_json` (plaintext) survives only as a holding area for legacy rows
  that predate the encrypted store. No kernel writer populates it anymore:
  `createProjectWorkspace` routes a `secrets` input through the encrypted
  store (writing `'{}'` to the column), `updateProjectWorkspace` rejects a
  `secrets` input outright, and the getters never return the column or a
  parsed `secrets` field. The only reader is `backfillWorkspaceSecrets`,
  which drains it.
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
workspace row and never leaks into caller logs or responses. Workspace
objects expose no `secrets` or `secrets_json` field at all — values are
reachable only through `getWorkspaceSecret`. `createProjectWorkspace`
accepts a `secrets` map for initial provisioning (validated and key-checked
before the workspace row is inserted; non-string values are stored as their
JSON serialization); `updateProjectWorkspace` throws if given `secrets`,
directing callers to the explicit per-secret API. `config` /
`resource_limits` / `metadata` parsing is unchanged.

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
- `backfillWorkspaceSecrets(details?)` (kernel export, run explicitly like
  `backfillProjectSources`) migrates legacy plaintext into envelopes and
  purges it, refusing to purge whenever the plaintext might be the last
  recoverable copy of anything:
  - Throws without `SIDEKICK_SECRET_KEY` before touching any row (fail
    closed).
  - Scans workspaces whose `secrets_json` is non-empty; each entry is
    encrypted into `platform_workspace_secrets` with
    `ON CONFLICT ... DO NOTHING`, so an envelope that already exists is never
    overwritten (the encrypted store is newer than the legacy plaintext — no
    double-encrypt, no rollback of a rotated value). An entry whose insert was
    skipped is then decrypt-checked: if the existing envelope no longer
    decrypts under the current key, the workspace's plaintext is retained.
  - Envelopes are written before `secrets_json` is cleared to `{}`, so an
    interrupted run loses nothing and a re-run migrates only what remains.
    The clear is conditional on `secrets_json` still holding the scanned
    value, so a concurrent legacy write survives for the next run.
  - Workspaces whose plaintext was kept (undecryptable existing envelope,
    non-null value under an empty name, concurrent write) are returned in
    `workspaces_retained`; unparseable `secrets_json` is left untouched and
    returned in `workspaces_unreadable`. Non-string values are stored as
    their JSON serialization; `null` values are counted as
    `secrets_skipped_null` and purged.
  - Emits one summary `workspace.secrets_backfilled` event (counts only, no
    names list, no values).
  - Remediation for `workspaces_retained`: inspect the workspace's
    `secrets_json` directly, re-key or delete the offending envelope (for the
    undecryptable case) or re-store the value under a valid name via
    `setWorkspaceSecret`, then re-run the backfill; `workspaces_unreadable`
    requires fixing the malformed JSON by hand first.
- The purge is one-way: no live code path writes `secrets_json` anymore, so
  once a deployment's backfill run drains it (no retained/unreadable
  workspaces reported), no code path can reintroduce or read the plaintext.
  At the file level, drained values may linger in WAL frames and free pages
  until a checkpoint — run `VACUUM` after a backfill if at-rest erasure of
  the residue matters.

## Tests

`test/project-identity.test.js`:

- PI.11 ciphertext at rest contains the envelope but never the plaintext
  (queries `platform_workspace_secrets.envelope_json`).
- PI.12 round-trip, missing name → `null`, missing workspace → `null`.
- PI.13 delete, re-delete, and name listing.
- PI.14 fail-closed without `SIDEKICK_SECRET_KEY`.
- PI.15 getters expose `secret_names` and never raw ciphertext.
- PI.16 backfill migrates legacy plaintext, clears `secrets_json`, round-trips
  values.
- PI.17 backfill never overwrites an existing envelope; re-runs migrate
  nothing.
- PI.18 backfill fails closed without the key, leaving plaintext untouched.
- PI.19 unreadable `secrets_json` is reported and left untouched.
- PI.20 a non-null value under an empty name keeps the workspace's plaintext.
- PI.21 plaintext survives when the existing envelope no longer decrypts.

`test/workspace-model.test.js`:

- WS.2 create with `secrets` stores envelopes only (`secrets_json` stays
  `{}`), getters expose `secret_names` and no `secrets`/`secrets_json`.
- WS.11 `updateProjectWorkspace` rejects a plaintext `secrets` input.
- WS.12 create with `secrets` fails closed without the key, inserting no
  workspace row; create without `secrets` needs no key.
- WS.13 malformed `secrets` shapes and non-serializable values are rejected
  before the workspace row exists.

`test/kernel-migration-parity.test.js` (KMP.1–KMP.4) verifies migration
`027` is applied, both boot paths produce identical `platform_*` DDL (17
tables / 38 indexes), and the kernel schema module stays in sync.

## Non-goals

- No encryption key rotation scheme (out of scope; `secret-cipher` key is
  environment-scoped).
- No automatic plaintext purge at boot or migration time — the purge happens
  only when `backfillWorkspaceSecrets` is run explicitly.
- No per-user secret access control (no users/teams model in Phase 3).
