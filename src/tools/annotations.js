// MCP tool annotations are advisory metadata for clients. Keep the defaults
// conservative: an unknown tool must not be advertised as read-only or closed
// world. Individual tools can override these values in their descriptor.

const READ_ONLY_TOOLS = new Set([
  "tools", "read", "list", "search", "get", "list_projects", "get_by_project",
  "resume", "db_schema", "db_stats", "db_search", "db_diff", "knowledge",
  "security_scan", "status", "metrics", "log_query", "tail", "find",
  "summarize", "filter", "diff", "hash", "validate", "template", "parse",
  "extract", "transform", "anonymize", "diff_files", "insight_report",
  "respond", "ci_status", "compute_route",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "bash", "write", "delete", "db_restore", "db_migrate", "runbook", "ops",
  "mission", "process", "service", "cron", "delay", "watch", "github",
  "teach", "secret", "queue", "orchestrate", "notify", "memory_import",
  "memory_manage", "sync_import", "tunnel", "wireguard", "nginx", "module",
  "project_registry", "workspace", "capability", "workflow", "browser",
  "store", "redis", "evolve", "compute_providers", "compute_jobs", "webhook",
]);

const OPEN_WORLD_TOOLS = new Set([
  "web_fetch", "download", "github", "ci_status", "llm", "embed", "ollama",
  "compute", "compute_nodes", "compute_providers", "compute_models", "compute_jobs",
  "compute_route", "browser", "media", "ocr", "transcribe", "notify", "webhook",
  "netdiag", "tunnel", "wireguard", "nginx", "redis", "service", "process",
]);

function getToolAnnotations(name) {
  const canonical = String(name || "").replace(/^sidekick_/, "");
  const readOnly = READ_ONLY_TOOLS.has(canonical);
  return Object.freeze({
    // Explicit booleans are intentional: clients must not depend on protocol
    // defaults, and an unknown/generated tool remains conservatively mutable.
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && DESTRUCTIVE_TOOLS.has(canonical),
    idempotentHint: readOnly,
    openWorldHint: OPEN_WORLD_TOOLS.has(canonical),
  });
}

module.exports = { getToolAnnotations };
