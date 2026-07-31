-- Approval Continuation v1 (docs/adr-approval-continuation.md).
--
-- Promotes approvals from a single JSON document to a real table, and adds the
-- durable suspended-execution checkpoint and recorded-outcome ledger that let a
-- Brain task parked at `waiting_for_approval` actually resume.
--
-- Ordering note: `approvals` carries a RESTRICT foreign key to
-- `task_checkpoints`, so the checkpoint table is created first. PRAGMA
-- foreign_keys is ON (src/db.js:30), so the constraint is enforced rather than
-- decorative.

-- ---------------------------------------------------------------------------
-- task_checkpoints — durable suspended execution (ADR §4.2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_checkpoints (
  task_id             TEXT PRIMARY KEY,
  root_task_id        TEXT,
  state               TEXT NOT NULL,

  -- Nullable so a tombstone can clear them (§4.5); the CHECK below makes them
  -- mandatory for every non-archived state, so an active checkpoint can never
  -- exist without its goal and plan.
  goal_encrypted      TEXT,
  classification_json TEXT NOT NULL DEFAULT '{}',

  plan_version        TEXT NOT NULL,
  plan_encrypted      TEXT,
  plan_digest         TEXT NOT NULL,

  -- Durable resume cursor. Set at park, untouched by every wake and refusal
  -- path, advanced only after an outcome has been consumed (§5/T1, I22).
  next_step_id        TEXT,

  -- Durable binding to the one live approval, plus enough action metadata to
  -- construct a result row WITHOUT reading the approval (required by T7, which
  -- runs precisely when the approval row is missing or unreadable).
  current_approval_id     TEXT,
  current_step_id         TEXT,
  current_args_digest     TEXT,
  current_idempotency_key TEXT,

  progress_encrypted  TEXT,
  evidence_encrypted  TEXT,
  evidence_chars      INTEGER NOT NULL DEFAULT 0,
  successful_tool_evidence INTEGER NOT NULL DEFAULT 0,

  claimed_by          TEXT,
  lease_expires_at    TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  claim_epoch         INTEGER NOT NULL DEFAULT 0,

  -- Identity of the PRIOR attempt, captured by T3 on a stale reclaim before it
  -- overwrites the live claim fields (I25). Durable rather than in-memory so a
  -- second crash does not lose the identity of the attempt that may have run.
  prior_operation_id  TEXT,
  prior_claimed_by    TEXT,
  prior_claim_epoch   INTEGER,
  prior_attempt_count INTEGER,

  deadline_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  platform_execution_id TEXT,
  root_execution_id     TEXT,
  schema_version        INTEGER NOT NULL DEFAULT 1,

  -- Encrypted content is required while a checkpoint is live and cleared only
  -- when it becomes a tombstone. Expressed as a constraint rather than a
  -- convention, so a bug that blanks a live checkpoint fails at the database.
  CHECK (
    state = 'archived'
    OR (goal_encrypted IS NOT NULL AND plan_encrypted IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_runnable
  ON task_checkpoints(state, lease_expires_at)
  WHERE state IN ('runnable', 'running');

-- Sweeper support: parked and reconciling tasks must be findable without a scan.
CREATE INDEX IF NOT EXISTS idx_task_checkpoints_parked
  ON task_checkpoints(state, updated_at)
  WHERE state IN ('waiting_for_approval', 'reconciling');

-- ---------------------------------------------------------------------------
-- approvals — promote the JSON document to a table (ADR §4.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  approval_id           TEXT PRIMARY KEY,
  status                TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  risk                  TEXT NOT NULL DEFAULT 'unknown',
  source                TEXT NOT NULL,
  mode                  TEXT,
  reason_encrypted      TEXT,

  -- binding
  task_id               TEXT,
  step_id               TEXT,
  plan_version          TEXT,
  args_digest           TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,

  -- payload: ciphertext only (§4.4). No plaintext arguments in any column,
  -- including redacted previews — those are generated on demand from the
  -- decrypted payload for an authorized viewer, never persisted.
  args_encrypted        TEXT,

  -- identity. Three distinct acts by three potentially different principals,
  -- each with its own columns. None is ever overwritten by another.
  requester_identity    TEXT,
  approver_identity     TEXT,
  terminalized_by       TEXT,
  terminalized_at       TEXT,
  reconciled_by         TEXT,
  reconciled_at         TEXT,
  reconciliation_decision TEXT,

  -- timing
  requested_at          TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  decided_at            TEXT,
  completed_at          TEXT,
  updated_at            TEXT NOT NULL,

  -- execution state. `operation_id` IS written for task-originated approvals
  -- as the correlation id of the claim. Only the LEASE fields stay NULL for
  -- them, because the authoritative lease is the checkpoint's.
  operation_id          TEXT,
  executor_id           TEXT,
  lease_expires_at      TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  reconciliation_status TEXT NOT NULL DEFAULT 'not_required',

  -- outcome. Digest only; result content lives encrypted in task_step_results.
  result_digest         TEXT,
  error_code            TEXT,
  error_detail_encrypted TEXT,

  platform_execution_id TEXT,
  timeout_ms            INTEGER,
  schema_version        INTEGER NOT NULL DEFAULT 1,

  -- Approvals are audit records and MUST outlive the working checkpoint.
  -- RESTRICT, never CASCADE: deleting a checkpoint must not destroy the record
  -- of what a human authorized (I13).
  FOREIGN KEY (task_id) REFERENCES task_checkpoints(task_id) ON DELETE RESTRICT
);

-- (a) AUTHORITATIVE. One approval record per action identity, for all time and
-- in every status. This is what makes a duplicate submission collide and what
-- makes a denial final for that exact action.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_idempotency
  ON approvals(idempotency_key);

-- (b) REDUNDANT BY CONSTRUCTION, retained deliberately. Every column here is an
-- input to the key in (a), so this constraint cannot fail unless the key
-- derivation is wrong — which is precisely its value.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_live_action
  ON approvals(task_id, step_id, plan_version, tool_name, args_digest)
  WHERE status IN ('pending', 'approved', 'executing',
                   'reconciliation_required', 'retry_authorized');

-- One live task-originated approval per task (§4.2). `reconciliation_required`
-- and `retry_authorized` are live statuses: an approval parked for
-- reconciliation still owns its task's authorization slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_one_live_per_task
  ON approvals(task_id)
  WHERE task_id IS NOT NULL
    AND status IN ('pending', 'approved', 'executing',
                   'reconciliation_required', 'retry_authorized');

CREATE INDEX IF NOT EXISTS idx_approvals_status_expiry ON approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_approvals_task          ON approvals(task_id);

-- ---------------------------------------------------------------------------
-- task_step_results — the recorded-outcome ledger (ADR §4.3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_step_results (
  task_id         TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  plan_version    TEXT NOT NULL,
  args_digest     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL,
  result_encrypted TEXT,
  result_digest   TEXT,
  outcome_code    TEXT,
  error_detail_encrypted TEXT,
  approval_id     TEXT,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, step_id, plan_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_step_results_idempotency
  ON task_step_results(idempotency_key);

-- ---------------------------------------------------------------------------
-- approval_execution_recovery_events — closed-vocabulary reasons (ADR §4.4)
--
-- The additive columns (`reason_code`, `reason_detail_encrypted`,
-- `recovery_executor_id`, `prior_claim_epoch`, `prior_attempt_count`) are
-- DELIBERATELY NOT ADDED HERE. They are owned by
-- `ensureApprovalContinuationSchema()` in src/approvals/store.js, which adds
-- each one only if `PRAGMA table_info` says it is missing.
--
-- Why: migrations run in ONE process (src/index.js, the MCP server), but the
-- runtime `ensure` runs in every process that touches approvals — including
-- sidekick-agent, which starts the continuation sweeper on boot. Service start
-- order is not guaranteed. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a bare
-- ALTER here would throw `duplicate column name` whenever the agent's ensure
-- won the race, the migration transaction would roll back, and
-- `runPendingMigrations` would rethrow — taking sidekick-mcp down on startup.
--
-- Everything in this file is idempotent (`CREATE ... IF NOT EXISTS`), so the
-- two paths can run in either order, any number of times. The ADR marks the
-- physical schema provisional (§9); this is that latitude being used to keep
-- one idempotent owner per object.
