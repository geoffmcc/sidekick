"use strict";

// Compatibility ordering is part of the public tool-catalog contract. The
// names are canonical registry metadata; the legacy catalog is derived from
// the descriptors below and is not an additional source of truth.
const CANONICAL_TOOL_ORDER = Object.freeze([
  "bash", "tools", "read", "write", "list", "store", "get", "delete", "resume", "web_fetch", "llm",
  "list_projects", "get_by_project", "search", "git", "notify", "process", "service", "archive", "cron",
  "github", "ci_status", "webhook", "context", "session", "handoff", "memory", "teach", "health", "delay",
  "snapshot", "watch", "secret", "security_scan", "hash", "queue", "retry", "evolve", "orchestrate",
  "predict", "debug_tool", "fresheyes", "batch", "cache", "summarize", "filter", "project", "memory_export",
  "memory_import", "memory_manage", "respond", "db_schema", "db_query", "db_stats", "db_backup", "db_restore",
  "log_query", "db_export", "db_search", "db_migrate", "db_diff", "redis", "ocr", "media", "transcribe",
  "analytics", "insight_report", "embed", "ollama", "tunnel", "download", "wireguard", "nginx", "knowledge",
  "metrics", "compute", "compute_nodes", "compute_providers", "compute_models", "compute_jobs", "compute_route",
  "module", "project_registry", "capability", "workflow", "connector", "workspace", "status", "netdiag",
  "changelog", "depend", "anonymize", "sandbox", "mission", "ops", "black_box", "circuit", "runbook",
  "sync_identity", "sync_export", "sync_import", "sync_diff", "diff_files", "find", "tail", "timeline", "baseline",
  "browser",
]);

module.exports = { CANONICAL_TOOL_ORDER };
