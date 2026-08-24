/**
 * Platform kernel schema — single source of truth for the runtime schema.
 *
 * `ensurePlatformKernelSchema()` in `kernel.js` executes this DDL so a
 * database bootstrapped purely at runtime matches one bootstrapped purely
 * through migrations. `migrations/011_platform_kernel.sql` established the
 * four base tables; `migrations/026_platform_kernel_tables.sql` adds the ten
 * remaining tables so fresh installs converge without dropping or renaming
 * anything; `migrations/027_platform_project_projection.sql` adds the project
 * projection tables and the encrypted workspace-secret store;
 * `migrations/028_platform_execution_claims.sql` adds the execution
 * claim/lease/checkpoint/cancel table, `migrations/030_platform_event_delivery.sql`
 * adds durable subscriber/delivery/offset state, and
 * `migrations/031_platform_connectors.sql` adds connector lifecycle state,
 * and `migrations/033_security_research_records.sql` adds bounded research
 * campaign, hypothesis, and test-run records; migration 034 adds evidence
 * linked findings and report metadata; migration 035 adds human-gated
 * disclosure metadata.
 * Keep the migration files in sync with this module.
 */
const KERNEL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS platform_executions (
    execution_id TEXT PRIMARY KEY,
    parent_execution_id TEXT,
    root_execution_id TEXT NOT NULL,
    task_id TEXT,
    session_id TEXT,
    workflow_id TEXT,
    project_id TEXT,
    incident_id TEXT,
    change_set_id TEXT,
    actor_id TEXT,
    client_id TEXT,
    trigger_type TEXT,
    operation_type TEXT NOT NULL,
    tool_name TEXT,
    tool_action TEXT,
    resource_scope TEXT,
    environment TEXT,
    state TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'unknown',
    approval_state TEXT NOT NULL DEFAULT 'not_required',
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deadline_at TEXT,
    heartbeat_at TEXT,
    result_status TEXT,
    error_category TEXT,
    result_summary TEXT,
    artifact_count INTEGER NOT NULL DEFAULT 0,
    trace_id TEXT,
    span_id TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(parent_execution_id) REFERENCES platform_executions(execution_id)
  );
  CREATE TABLE IF NOT EXISTS platform_execution_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    actor_id TEXT,
    subject_type TEXT,
    subject_id TEXT,
    project_id TEXT,
    environment TEXT,
    execution_id TEXT,
    root_execution_id TEXT,
    task_id TEXT,
    session_id TEXT,
    severity TEXT NOT NULL DEFAULT 'info',
    payload_json TEXT NOT NULL DEFAULT '{}',
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    dedupe_key TEXT,
    causation_id TEXT,
    correlation_id TEXT,
    redaction_state TEXT NOT NULL DEFAULT 'redacted',
    FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id)
  );
  CREATE TABLE IF NOT EXISTS platform_event_subscriptions (
    subscription_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS platform_event_deliveries (
    delivery_id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(subscription_id) REFERENCES platform_event_subscriptions(subscription_id),
    FOREIGN KEY(event_id) REFERENCES platform_execution_events(event_id)
  );
  CREATE TABLE IF NOT EXISTS platform_event_offsets (
    subscription_id TEXT PRIMARY KEY,
    last_event_id TEXT,
    last_event_rowid INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(subscription_id) REFERENCES platform_event_subscriptions(subscription_id)
  );
  CREATE TABLE IF NOT EXISTS platform_connectors (
    connector_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'registered',
    endpoint TEXT,
    secret_ref TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    config_json TEXT NOT NULL DEFAULT '{}',
    health_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_health_check_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS platform_scope_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    rules_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    supersedes_snapshot_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(supersedes_snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
  );
  CREATE TABLE IF NOT EXISTS platform_scope_targets (
    target_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    value_digest TEXT NOT NULL,
    target_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
  );
  CREATE TABLE IF NOT EXISTS platform_research_campaigns (
    campaign_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    scope_snapshot_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(scope_snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_research_campaigns_project ON platform_research_campaigns(project_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_research_campaigns_state ON platform_research_campaigns(state, updated_at DESC);
  CREATE TABLE IF NOT EXISTS platform_research_hypotheses (
    hypothesis_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    claim TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'proposed',
    rationale TEXT,
    prerequisites_json TEXT NOT NULL DEFAULT '[]',
    criteria_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_research_hypotheses_campaign ON platform_research_hypotheses(campaign_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_research_hypotheses_state ON platform_research_hypotheses(state, updated_at DESC);
  CREATE TABLE IF NOT EXISTS platform_research_test_runs (
    test_run_id TEXT PRIMARY KEY,
    hypothesis_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    execution_id TEXT,
    scope_snapshot_id TEXT,
    state TEXT NOT NULL DEFAULT 'not_run',
    environment_json TEXT NOT NULL DEFAULT '{}',
    outcome TEXT,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(hypothesis_id) REFERENCES platform_research_hypotheses(hypothesis_id),
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
    FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id),
    FOREIGN KEY(scope_snapshot_id) REFERENCES platform_scope_snapshots(snapshot_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_research_test_runs_hypothesis ON platform_research_test_runs(hypothesis_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_research_test_runs_execution ON platform_research_test_runs(execution_id);
  CREATE TABLE IF NOT EXISTS platform_research_findings (
    finding_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    hypothesis_id TEXT,
    test_run_id TEXT,
    title TEXT NOT NULL,
    claim TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'analysis_only',
    impact TEXT,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
    FOREIGN KEY(hypothesis_id) REFERENCES platform_research_hypotheses(hypothesis_id),
    FOREIGN KEY(test_run_id) REFERENCES platform_research_test_runs(test_run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_research_findings_campaign ON platform_research_findings(campaign_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_research_findings_status ON platform_research_findings(status, updated_at DESC);
  CREATE TABLE IF NOT EXISTS platform_research_reports (
    report_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    artifact_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    finding_refs_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
    FOREIGN KEY(artifact_id) REFERENCES platform_artifacts(artifact_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_research_reports_campaign ON platform_research_reports(campaign_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_research_reports_status ON platform_research_reports(status, updated_at DESC);
  CREATE TABLE IF NOT EXISTS platform_research_disclosures (
    disclosure_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    report_id TEXT NOT NULL,
    artifact_id TEXT,
    recipient_ref TEXT,
    approval_ref TEXT,
    state TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id),
    FOREIGN KEY(report_id) REFERENCES platform_research_reports(report_id),
    FOREIGN KEY(artifact_id) REFERENCES platform_artifacts(artifact_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_research_disclosures_campaign ON platform_research_disclosures(campaign_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_research_disclosures_state ON platform_research_disclosures(state, updated_at DESC);
  CREATE TABLE IF NOT EXISTS platform_artifacts (
    artifact_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    project_id TEXT,
    execution_id TEXT,
    task_id TEXT,
    session_id TEXT,
    producer TEXT,
    storage_ref TEXT NOT NULL,
    content_type TEXT,
    byte_size INTEGER,
    content_hash TEXT,
    created_at TEXT NOT NULL,
    retention_class TEXT NOT NULL DEFAULT 'standard',
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    redaction_state TEXT NOT NULL DEFAULT 'unknown',
    schema_version INTEGER NOT NULL DEFAULT 1,
    lineage_json TEXT NOT NULL DEFAULT '{}',
    verification_json TEXT NOT NULL DEFAULT '{}',
    supersedes_artifact_id TEXT,
    deleted_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id),
    FOREIGN KEY(supersedes_artifact_id) REFERENCES platform_artifacts(artifact_id)
  );
  CREATE TABLE IF NOT EXISTS platform_execution_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT NOT NULL,
    actor_id TEXT,
    reason TEXT,
    event_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id),
    FOREIGN KEY(event_id) REFERENCES platform_execution_events(event_id)
  );

  CREATE TABLE IF NOT EXISTS platform_capabilities (
    capability_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    project_id TEXT,
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_capabilities_actor ON platform_capabilities(actor_id, capability, project_id) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_platform_capabilities_actor_scan ON platform_capabilities(actor_id, revoked_at);

  CREATE TABLE IF NOT EXISTS platform_change_sets (
    change_set_id TEXT PRIMARY KEY,
    execution_id TEXT,
    approval_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_action TEXT,
    operation_type TEXT NOT NULL,
    state TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    previous_hash TEXT,
    actor_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    args_snapshot_json TEXT NOT NULL DEFAULT '{}',
    result_summary TEXT,
    created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_platform_change_sets_approval ON platform_change_sets(approval_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_platform_change_sets_execution ON platform_change_sets(execution_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_platform_change_sets_hash ON platform_change_sets(content_hash);

  CREATE TABLE IF NOT EXISTS platform_workflows (
    workflow_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    state TEXT NOT NULL DEFAULT 'defined',
    current_step INTEGER NOT NULL DEFAULT 0,
    total_steps INTEGER NOT NULL DEFAULT 0,
    execution_id TEXT,
    project_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    failed_at TEXT,
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_platform_workflows_state ON platform_workflows(state, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_workflows_project ON platform_workflows(project_id, state);

  CREATE TABLE IF NOT EXISTS platform_workflow_steps (
    step_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    tool_name TEXT,
    tool_action TEXT,
    args_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    result_summary TEXT,
    error_category TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 0,
    execution_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workflow_steps_idx ON platform_workflow_steps(workflow_id, step_index);
  CREATE INDEX IF NOT EXISTS idx_platform_workflow_steps_state ON platform_workflow_steps(state, workflow_id);

  CREATE TABLE IF NOT EXISTS platform_runner_sessions (
    runner_id TEXT PRIMARY KEY,
    execution_id TEXT,
    workflow_id TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    resource_limits_json TEXT NOT NULL DEFAULT '{}',
    resource_usage_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    heartbeat_at TEXT,
    completed_at TEXT,
    terminated_reason TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_platform_runner_sessions_state ON platform_runner_sessions(state, started_at DESC);

  CREATE TABLE IF NOT EXISTS platform_project_workspaces (
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    config_json TEXT NOT NULL DEFAULT '{}',
    secrets_json TEXT NOT NULL DEFAULT '{}',
    environment TEXT,
    resource_limits_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_workspaces_project ON platform_project_workspaces(project_id) WHERE state = 'active';
  CREATE INDEX IF NOT EXISTS idx_platform_workspaces_owner ON platform_project_workspaces(owner_id, state);
  CREATE INDEX IF NOT EXISTS idx_platform_workspaces_state ON platform_project_workspaces(state, updated_at DESC);

  CREATE TABLE IF NOT EXISTS platform_projects (
    project_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT,
    owner_actor_id TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_platform_projects_state ON platform_projects(state, updated_at DESC);

  CREATE TABLE IF NOT EXISTS platform_project_sources (
    project_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (project_id, source, source_id),
    FOREIGN KEY(project_id) REFERENCES platform_projects(project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_project_sources_project ON platform_project_sources(project_id, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_project_sources_source ON platform_project_sources(source, source_id, last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS platform_workspace_secrets (
    workspace_id TEXT NOT NULL,
    secret_name TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, secret_name),
    FOREIGN KEY(workspace_id) REFERENCES platform_project_workspaces(workspace_id)
  );

  CREATE TABLE IF NOT EXISTS platform_model_registry (
    model_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    version TEXT,
    state TEXT NOT NULL DEFAULT 'registered',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    context_window INTEGER,
    max_output_tokens INTEGER,
    supports_streaming INTEGER NOT NULL DEFAULT 0,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    supports_tools INTEGER NOT NULL DEFAULT 1,
    cost_per_1k_input REAL,
    cost_per_1k_output REAL,
    rate_limit_rpm INTEGER,
    registered_by TEXT,
    registered_at TEXT NOT NULL,
    deprecated_at TEXT,
    last_used_at TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_model_name_provider ON platform_model_registry(name, provider);
  CREATE INDEX IF NOT EXISTS idx_platform_model_state ON platform_model_registry(state, registered_at DESC);

  CREATE TABLE IF NOT EXISTS platform_extensions (
    extension_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'registered',
    type TEXT NOT NULL DEFAULT 'plugin',
    author TEXT,
    description TEXT,
    entry_point TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    dependencies_json TEXT NOT NULL DEFAULT '[]',
    config_schema_json TEXT NOT NULL DEFAULT '{}',
    config_json TEXT NOT NULL DEFAULT '{}',
    hooks_json TEXT NOT NULL DEFAULT '[]',
    registered_at TEXT NOT NULL,
    activated_at TEXT,
    deactivated_at TEXT,
    uninstalled_at TEXT,
    last_used_at TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_extension_name ON platform_extensions(name);
  CREATE INDEX IF NOT EXISTS idx_platform_extension_state ON platform_extensions(state, registered_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_extension_type ON platform_extensions(type, state);

  CREATE TABLE IF NOT EXISTS platform_releases (
    release_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    codename TEXT,
    description TEXT,
    changelog_json TEXT NOT NULL DEFAULT '[]',
    migration_version INTEGER,
    breaking_changes_json TEXT NOT NULL DEFAULT '[]',
    deprecations_json TEXT NOT NULL DEFAULT '[]',
    upgrade_notes TEXT,
    released_by TEXT,
    released_at TEXT,
    created_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_release_version ON platform_releases(version);
  CREATE INDEX IF NOT EXISTS idx_platform_release_state ON platform_releases(state, released_at DESC);

  CREATE TABLE IF NOT EXISTS platform_backups (
    backup_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'created',
    type TEXT NOT NULL DEFAULT 'full',
    tables_included_json TEXT NOT NULL DEFAULT '[]',
    row_counts_json TEXT NOT NULL DEFAULT '{}',
    file_path TEXT,
    file_size_bytes INTEGER,
    checksum TEXT,
    compression TEXT DEFAULT 'none',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    restored_at TEXT,
    expires_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_platform_backup_state ON platform_backups(state, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_backup_type ON platform_backups(type, state);

  CREATE INDEX IF NOT EXISTS idx_platform_executions_root ON platform_executions(root_execution_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_executions_parent ON platform_executions(parent_execution_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_executions_project ON platform_executions(project_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_executions_state ON platform_executions(state, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_executions_trace ON platform_executions(trace_id, span_id);
  CREATE INDEX IF NOT EXISTS idx_platform_events_execution ON platform_execution_events(execution_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_platform_events_correlation ON platform_execution_events(correlation_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_platform_events_type ON platform_execution_events(event_type, timestamp DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_events_dedupe ON platform_execution_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_event_subscriptions_name ON platform_event_subscriptions(name);
  CREATE INDEX IF NOT EXISTS idx_platform_event_subscriptions_type_state ON platform_event_subscriptions(event_type, state);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_event_deliveries_subscription_event ON platform_event_deliveries(subscription_id, event_id);
  CREATE INDEX IF NOT EXISTS idx_platform_event_deliveries_status_next ON platform_event_deliveries(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_platform_event_deliveries_event ON platform_event_deliveries(event_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_connectors_name ON platform_connectors(name);
  CREATE INDEX IF NOT EXISTS idx_platform_connectors_type_state ON platform_connectors(type, state);
  CREATE INDEX IF NOT EXISTS idx_platform_connectors_state_updated ON platform_connectors(state, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_scope_snapshot_digest ON platform_scope_snapshots(digest);
  CREATE INDEX IF NOT EXISTS idx_platform_scope_snapshot_project ON platform_scope_snapshots(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_scope_snapshot_state_expiry ON platform_scope_snapshots(state, expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_scope_target_value ON platform_scope_targets(snapshot_id, kind, value_digest);
  CREATE INDEX IF NOT EXISTS idx_platform_scope_target_snapshot ON platform_scope_targets(snapshot_id, kind);
  CREATE INDEX IF NOT EXISTS idx_platform_artifacts_execution ON platform_artifacts(execution_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_artifacts_project ON platform_artifacts(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_artifacts_hash ON platform_artifacts(content_hash);
  CREATE INDEX IF NOT EXISTS idx_platform_transitions_execution ON platform_execution_transitions(execution_id, created_at);

  CREATE TABLE IF NOT EXISTS platform_execution_claims (
    execution_id TEXT PRIMARY KEY,
    claimed_by TEXT,
    claim_epoch INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(execution_id) REFERENCES platform_executions(execution_id)
  );
  CREATE INDEX IF NOT EXISTS idx_platform_execution_claims_lease ON platform_execution_claims(lease_expires_at) WHERE lease_expires_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS platform_research_source_repositories (
    repository_id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'directory',
    source_locator TEXT,
    remote_identity TEXT,
    default_authority_class TEXT NOT NULL DEFAULT 'derived_analysis_input',
    state TEXT NOT NULL DEFAULT 'active',
    selected_snapshot_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
  );
  CREATE INDEX IF NOT EXISTS idx_research_source_repositories_campaign ON platform_research_source_repositories(campaign_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_research_source_repositories_project ON platform_research_source_repositories(project_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS platform_research_source_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    acquisition_operation_id TEXT,
    source_type TEXT NOT NULL DEFAULT 'directory',
    requested_ref TEXT,
    resolved_commit_sha TEXT,
    branch TEXT,
    remote_identity TEXT,
    state TEXT NOT NULL DEFAULT 'staging',
    storage_ref TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_root_hash TEXT NOT NULL DEFAULT '',
    file_count INTEGER NOT NULL DEFAULT 0,
    byte_count INTEGER NOT NULL DEFAULT 0,
    max_depth INTEGER NOT NULL DEFAULT 0,
    authority TEXT NOT NULL DEFAULT 'derived_analysis_input',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finalized_at TEXT,
    verification_at TEXT,
    archived_at TEXT,
    removed_at TEXT,
    verification_json TEXT NOT NULL DEFAULT '{}',
    authority_provenance_json TEXT NOT NULL DEFAULT '{}',
    semantic_index_json TEXT NOT NULL DEFAULT '{}',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    retention_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(repository_id) REFERENCES platform_research_source_repositories(repository_id),
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
  );
  CREATE INDEX IF NOT EXISTS idx_research_source_snapshots_repository ON platform_research_source_snapshots(repository_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_research_source_snapshots_campaign ON platform_research_source_snapshots(campaign_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_research_source_snapshots_state ON platform_research_source_snapshots(state, created_at DESC);
  CREATE TABLE IF NOT EXISTS platform_research_source_authority_claims (
    claim_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    authority_class TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    declaring_actor TEXT NOT NULL,
    declared_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(snapshot_id) REFERENCES platform_research_source_snapshots(snapshot_id),
    FOREIGN KEY(repository_id) REFERENCES platform_research_source_repositories(repository_id),
    FOREIGN KEY(campaign_id) REFERENCES platform_research_campaigns(campaign_id)
  );
  CREATE INDEX IF NOT EXISTS idx_research_source_authority_claims_snapshot ON platform_research_source_authority_claims(snapshot_id, declared_at DESC);
  CREATE INDEX IF NOT EXISTS idx_research_source_authority_claims_campaign ON platform_research_source_authority_claims(campaign_id, declared_at DESC);
  CREATE INDEX IF NOT EXISTS idx_research_source_authority_claims_project ON platform_research_source_authority_claims(project_id, declared_at DESC);

  CREATE TABLE IF NOT EXISTS platform_network_scopes (
    scope_id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    current_revision INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS platform_network_scope_revisions (
    scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    digest TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY(scope_id, revision),
    FOREIGN KEY(scope_id) REFERENCES platform_network_scopes(scope_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_network_scope_digest ON platform_network_scope_revisions(digest);
  CREATE INDEX IF NOT EXISTS idx_network_scope_state ON platform_network_scopes(state, name);

  INSERT OR REPLACE INTO meta (key, value) VALUES ('platform_kernel_schema_version', '12');
`;

module.exports = { KERNEL_SCHEMA_SQL };
