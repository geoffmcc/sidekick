-- Sidekick Compute v1: Provider-neutral, hardware-neutral compute system
-- Providers, models, workers, jobs, executors, routing rules, artifacts, benchmarks.

-- Provider registry
CREATE TABLE IF NOT EXISTS compute_providers (
  provider_id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  endpoint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  trust_level TEXT NOT NULL DEFAULT 'private',
  auth_secret_key TEXT,
  tls_policy TEXT NOT NULL DEFAULT 'prefer',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_last_check TEXT,
  health_last_success TEXT,
  health_last_error TEXT,
  health_failure_count INTEGER NOT NULL DEFAULT 0,
  health_circuit_state TEXT NOT NULL DEFAULT 'closed',
  health_circuit_opened_at TEXT,
  priority INTEGER NOT NULL DEFAULT 50,
  cost_policy TEXT NOT NULL DEFAULT 'free',
  data_classifications_json TEXT NOT NULL DEFAULT '["public","internal","private"]',
  mode TEXT NOT NULL DEFAULT 'direct',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_providers_type ON compute_providers(provider_type);
CREATE INDEX IF NOT EXISTS idx_compute_providers_enabled ON compute_providers(enabled);
CREATE INDEX IF NOT EXISTS idx_compute_providers_health ON compute_providers(health_status);
CREATE INDEX IF NOT EXISTS idx_compute_providers_mode ON compute_providers(mode);

-- Model registry
CREATE TABLE IF NOT EXISTS compute_models (
  model_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES compute_providers(provider_id) ON DELETE CASCADE,
  provider_model_name TEXT NOT NULL,
  display_name TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  context_limit INTEGER,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  supports_structured_output INTEGER NOT NULL DEFAULT 0,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_embedding INTEGER NOT NULL DEFAULT 0,
  estimated_memory_bytes INTEGER,
  quantization TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  preferred_workloads_json TEXT NOT NULL DEFAULT '[]',
  deprecated INTEGER NOT NULL DEFAULT 0,
  deprecation_notice TEXT,
  benchmark_score REAL,
  benchmark_last_run TEXT,
  last_verified TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_models_provider ON compute_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_compute_models_enabled ON compute_models(enabled);
CREATE INDEX IF NOT EXISTS idx_compute_models_embedding ON compute_models(supports_embedding);
CREATE INDEX IF NOT EXISTS idx_compute_models_vision ON compute_models(supports_vision);

-- Worker registry
CREATE TABLE IF NOT EXISTS compute_workers (
  worker_id TEXT PRIMARY KEY,
  node_id TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  architecture TEXT,
  cpu_info TEXT,
  memory_bytes INTEGER,
  accelerators_json TEXT NOT NULL DEFAULT '[]',
  providers_json TEXT NOT NULL DEFAULT '[]',
  executors_json TEXT NOT NULL DEFAULT '[]',
  worker_version TEXT,
  trust_level TEXT NOT NULL DEFAULT 'trusted',
  state TEXT NOT NULL DEFAULT 'offline',
  current_jobs INTEGER NOT NULL DEFAULT 0,
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 1,
  utilization_json TEXT NOT NULL DEFAULT '{}',
  last_heartbeat TEXT,
  heartbeat_interval_ms INTEGER NOT NULL DEFAULT 30000,
  maintenance_mode INTEGER NOT NULL DEFAULT 0,
  revocation_reason TEXT,
  revoked_at TEXT,
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  enrollment_token_hash TEXT,
  public_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_workers_node ON compute_workers(node_id);
CREATE INDEX IF NOT EXISTS idx_compute_workers_state ON compute_workers(state);
CREATE INDEX IF NOT EXISTS idx_compute_workers_platform ON compute_workers(platform);
CREATE INDEX IF NOT EXISTS idx_compute_workers_trust ON compute_workers(trust_level);

-- Worker enrollment tokens
CREATE TABLE IF NOT EXISTS compute_enrollment_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  display_name TEXT,
  trust_level TEXT NOT NULL DEFAULT 'trusted',
  allowed_data_classifications_json TEXT NOT NULL DEFAULT '["public","internal","private"]',
  max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_worker TEXT,
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_enrollment_hash ON compute_enrollment_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_compute_enrollment_expires ON compute_enrollment_tokens(expires_at);

-- Compute jobs
CREATE TABLE IF NOT EXISTS compute_jobs (
  job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  capability TEXT NOT NULL,
  source TEXT,
  project TEXT,
  task_id TEXT,
  session_id TEXT,
  root_execution_id TEXT,
  parent_execution_id TEXT,
  requesting_actor TEXT,
  data_classification TEXT NOT NULL DEFAULT 'private',
  capability_requirements_json TEXT NOT NULL DEFAULT '{}',
  routing_preferences_json TEXT NOT NULL DEFAULT '{}',
  request_payload_json TEXT NOT NULL DEFAULT '{}',
  selected_provider_id TEXT,
  selected_model_id TEXT,
  selected_worker_id TEXT,
  lease_id TEXT,
  lease_expires_at TEXT,
  lease_renewed_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'created',
  progress_percent INTEGER NOT NULL DEFAULT 0,
  progress_message TEXT,
  result_json TEXT,
  result_hash TEXT,
  error_category TEXT,
  error_message TEXT,
  fallback_history_json TEXT NOT NULL DEFAULT '[]',
  approval_required INTEGER NOT NULL DEFAULT 0,
  approval_state TEXT NOT NULL DEFAULT 'not_required',
  input_hash TEXT,
  timeout_ms INTEGER,
  started_at TEXT,
  queued_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_jobs_status ON compute_jobs(status);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_type ON compute_jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_worker ON compute_jobs(selected_worker_id);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_provider ON compute_jobs(selected_provider_id);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_project ON compute_jobs(project);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_created ON compute_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_cap ON compute_jobs(capability);
CREATE INDEX IF NOT EXISTS idx_compute_jobs_lease ON compute_jobs(lease_id);

-- Compute job attempts
CREATE TABLE IF NOT EXISTS compute_job_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES compute_jobs(job_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  worker_id TEXT,
  lease_id TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms INTEGER,
  result_json TEXT,
  result_hash TEXT,
  error_category TEXT,
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  first_token_latency_ms INTEGER,
  total_latency_ms INTEGER,
  accelerator TEXT,
  model_load_time_ms INTEGER,
  fallback_reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_attempts_job ON compute_job_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_compute_attempts_status ON compute_job_attempts(status);
CREATE INDEX IF NOT EXISTS idx_compute_attempts_worker ON compute_job_attempts(worker_id);

-- Compute artifacts
CREATE TABLE IF NOT EXISTS compute_artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES compute_jobs(job_id) ON DELETE CASCADE,
  attempt_id TEXT,
  artifact_type TEXT NOT NULL,
  name TEXT NOT NULL,
  storage_path TEXT,
  storage_ref TEXT,
  content_type TEXT,
  content_hash TEXT,
  size_bytes INTEGER,
  sensitivity TEXT NOT NULL DEFAULT 'private',
  retention_days INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_artifacts_job ON compute_artifacts(job_id);
CREATE INDEX IF NOT EXISTS idx_compute_artifacts_type ON compute_artifacts(artifact_type);

-- Compute routing rules
CREATE TABLE IF NOT EXISTS compute_routing_rules (
  rule_id TEXT PRIMARY KEY,
  rule_name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  workload_class TEXT,
  capability_filter TEXT,
  provider_filter TEXT,
  model_filter TEXT,
  worker_filter TEXT,
  data_classification_filter TEXT,
  trust_level_min TEXT,
  preferred_provider_ids_json TEXT NOT NULL DEFAULT '[]',
  preferred_model_ids_json TEXT NOT NULL DEFAULT '[]',
  preferred_worker_ids_json TEXT NOT NULL DEFAULT '[]',
  fallback_provider_ids_json TEXT NOT NULL DEFAULT '[]',
  max_latency_ms INTEGER,
  require_vision INTEGER NOT NULL DEFAULT 0,
  require_tools INTEGER NOT NULL DEFAULT 0,
  require_embedding INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_routing_workload ON compute_routing_rules(workload_class);
CREATE INDEX IF NOT EXISTS idx_compute_routing_priority ON compute_routing_rules(priority DESC);
CREATE INDEX IF NOT EXISTS idx_compute_routing_enabled ON compute_routing_rules(enabled);

-- Compute benchmarks
CREATE TABLE IF NOT EXISTS compute_benchmarks (
  benchmark_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  worker_id TEXT,
  benchmark_type TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  provider_availability REAL,
  model_load_time_ms INTEGER,
  first_token_latency_ms INTEGER,
  generation_tokens_per_sec REAL,
  embedding_tokens_per_sec REAL,
  peak_memory_bytes INTEGER,
  failure_rate REAL,
  cancellation_responsiveness_ms INTEGER,
  hardware_json TEXT NOT NULL DEFAULT '{}',
  model_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_benchmarks_provider ON compute_benchmarks(provider_id);
CREATE INDEX IF NOT EXISTS idx_compute_benchmarks_type ON compute_benchmarks(benchmark_type);
CREATE INDEX IF NOT EXISTS idx_compute_benchmarks_created ON compute_benchmarks(created_at);

-- Compute metrics (normalized)
CREATE TABLE IF NOT EXISTS compute_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_type TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  worker_id TEXT,
  job_id TEXT,
  value REAL NOT NULL,
  unit TEXT,
  tags_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compute_metrics_type ON compute_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_compute_metrics_provider ON compute_metrics(provider_id);
CREATE INDEX IF NOT EXISTS idx_compute_metrics_recorded ON compute_metrics(recorded_at);
