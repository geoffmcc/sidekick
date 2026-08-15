-- Runtime schema convergence: move runtime-only columns into migration history.
--
-- These columns were historically created only by the runtime bootstraps
-- (src/predict.js ensureSchema and src/blackbox.js migrateSchema), leaving the
-- migration set non-self-contained for them. SQLite has no ADD COLUMN IF NOT
-- EXISTS, so the migration runner (src/db.js execMigrationSql) applies each
-- ALTER TABLE ADD COLUMN idempotently: every statement below is a no-op when
-- the column already exists (e.g. after the runtime bootstrap created it),
-- which keeps both boot orders (migrations-then-runtime and
-- runtime-then-migrations) safe. Column types match the runtime ensureColumn
-- calls exactly (src/predict.js:243-247, src/blackbox.js:455-458).
-- schema_version is stamped by the migration runner from this filename, as
-- with every migration since 007 (036's in-file bump is the separate
-- platform_kernel_schema_version key, which does not apply here).

-- predictions: v2 identity model (src/predict.js ensureSchema)
ALTER TABLE predictions ADD COLUMN identity_key TEXT;
ALTER TABLE predictions ADD COLUMN last_seen_at TEXT;
ALTER TABLE predictions ADD COLUMN refresh_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE predictions ADD COLUMN lifecycle_reason TEXT;

-- prediction_feedback: scoped feedback (src/predict.js ensureSchema)
ALTER TABLE prediction_feedback ADD COLUMN scope_key TEXT;

-- blackbox_captures: capture diagnostics and retry lineage
-- (src/blackbox.js migrateSchema)
ALTER TABLE blackbox_captures ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE blackbox_captures ADD COLUMN retry_of TEXT;
