# Database Administration: backends, queries and migrations

The pack supports the configured `sqlite` or `postgres` backend. `database-audit`
uses `db_schema` and `db_stats` for bounded structure and size evidence;
`migration-readiness` inspects migration status and does not apply migrations.
Use `db_query` only with SQL placeholders and an explicit parameter array. The
pack dispatches queries as read-only and applies row and timeout limits.

`db_backup`, `db_restore`, `db_diff`, and migration application are separate
governed operations. A healthy schema or current migration status does not prove
backup recoverability. Empty results, unavailable backends, and blocked queries
must be reported as unknown or failed rather than normal. Never place credentials
or raw secret values in queries, configuration, or knowledge.
