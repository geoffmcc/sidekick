# Backup, Restore and DR: procedures and recovery limits

`database-backup` creates a bounded database backup with the configured
SQLite/Postgres selection and optional compression. Record the output reference
and verify its integrity before relying on it. `backup-readiness` uses optional
Proxmox evidence to assess coverage and readiness; unavailable Proxmox data is
unknown, not healthy. `db-diff` compares two snapshots mechanically and does
not prove recoverability.

The readiness tool returns a concise summary with uncovered guests, recent
backup failures, verification findings, and an explicit `restoreability: unknown`
value. Its `ok` field describes whether the evidence collection completed;
inspect `status` and findings for attention or partial data. Missing evidence
must not be reported as a clean backup state.

Restore is critical and separate from this pack's read-only readiness checks.
It must be explicitly approved, integrity-checked, followed by service and data
verification, and never tested against the only production copy. Define RPO/RTO
and perform a restore rehearsal before claiming disaster recovery. A successful
backup request or a valid snapshot comparison alone is not proof of a usable
restore.
