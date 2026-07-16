CREATE TABLE IF NOT EXISTS approval_execution_recovery_events (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  operation_id TEXT,
  executor_id TEXT,
  event_type TEXT NOT NULL,
  reconciliation_status TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_recovery_approval ON approval_execution_recovery_events(approval_id);
CREATE INDEX IF NOT EXISTS idx_approval_recovery_operation ON approval_execution_recovery_events(operation_id);
CREATE INDEX IF NOT EXISTS idx_approval_recovery_status ON approval_execution_recovery_events(reconciliation_status);
