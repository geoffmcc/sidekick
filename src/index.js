require("./env");
const express = require("express");
const cors = require("cors");
const { timingSafeCompare } = require("./crypto-utils");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { WebStandardStreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");
const { TOOLS, TOOL_DEFS, DATA_DIR, setSource, logToolCall, loadProcedures, enforceToolPolicy, syncToolRegistry } = require("./tools");
const dbStore = require("./db");

const API_KEY = process.env.SIDEKICK_API_KEY || "sk-sidekick-local-dev";
const PORT = parseInt(process.env.SIDEKICK_PORT || "4097", 10);
const ALLOWED_IPS = (process.env.SIDEKICK_ALLOWED_IPS || "").split(",").map(s => s.trim()).filter(Boolean);

function ipInRange(ip, cidr) {
  if (!cidr.includes("/")) return ip === cidr;
  const [rangeIp, bits] = cidr.split("/");
  const maskBits = parseInt(bits, 10);
  if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) return false;
  const mask = ~(2 ** (32 - maskBits) - 1) >>> 0;
  const ipNum = ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  const rangeNum = rangeIp.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function logDebug(context, data) {
  const ts = new Date().toISOString();
  const prefix = `[MCP-DEBUG ${ts}]`;
  if (typeof data === 'string') {
    console.log(`${prefix} ${context}: ${data}`);
  } else {
    console.log(`${prefix} ${context}:`, JSON.stringify(data, null, 2));
  }
}

const TOOL_SCHEMAS = {
  sidekick_bash: z.object({ command: z.string().describe("Shell command to execute") }),
  sidekick_read: z.object({ path: z.string().describe("Absolute path to the file to read") }),
  sidekick_write: z.object({ path: z.string().describe("Absolute path to write to"), content: z.string().describe("File content to write") }),
  sidekick_store: z.object({ 
    key: z.string().describe("Storage key"), 
    value: z.string().describe("Value to store"),
    project: z.string().optional().describe("Project name (lowercase, underscores only)"),
    category: z.string().optional().describe("Category tag for filtering (e.g. 'mcp', 'tool', 'config')")
  }),
  sidekick_get: z.object({ key: z.string().describe("Storage key to retrieve") }),
  sidekick_list: z.object({ path: z.string().optional().default("/home/sidekick").describe("Directory path to list") }),
  sidekick_web_fetch: z.object({
    url: z.string().describe("URL to fetch"),
    method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method"),
    headers: z.string().optional().describe("JSON object of extra headers"),
    body: z.string().optional().describe("Request body (for POST)")
  }),
  sidekick_llm: z.object({
    prompt: z.string().describe("The prompt to send to the LLM"),
    system: z.string().optional().describe("System prompt override"),
    temperature: z.number().optional().default(0.7).describe("Sampling temperature (0-2)"),
    provider: z.string().optional().describe("LLM provider: 'ollama' (default) or 'groq' (cloud)")
  }),
  sidekick_list_projects: z.object({}),
  sidekick_get_by_project: z.object({ project: z.string().describe("Project name to filter by") }),
  sidekick_search: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("Directory to search in (defaults to current directory)"),
    include: z.string().optional().describe("File pattern to include (e.g. '*.js', '*.ts')")
  }),
  sidekick_git: z.object({
    action: z.enum(["status", "diff", "log", "add", "commit", "push", "pull", "branch", "checkout", "stash"]).describe("Git action to perform"),
    path: z.string().optional().describe("Repository path (defaults to current directory)"),
    args: z.string().optional().describe("Additional arguments for the git command")
  }),
  sidekick_notify: z.object({
    channel: z.enum(["discord", "slack", "email"]).describe("Notification channel"),
    webhook_url: z.string().optional().describe("Webhook URL (required for discord/slack)"),
    recipient: z.string().optional().describe("Email recipient (required for email)"),
    message: z.string().describe("Message content to send"),
    title: z.string().optional().describe("Optional title/subject")
  }),
  sidekick_process: z.object({
    action: z.enum(["list", "top", "kill", "tree"]).describe("Process action to perform"),
    filter: z.string().optional().describe("Filter processes by name (for list action)"),
    pid: z.number().optional().describe("Process ID to kill"),
    name: z.string().optional().describe("Process name to kill (alternative to pid)"),
    signal: z.string().optional().describe("Signal to send when killing (default: TERM)")
  }),
  sidekick_service: z.object({
    action: z.enum(["start", "stop", "restart", "status", "enable", "disable", "logs"]).describe("Service action to perform"),
    service: z.string().describe("Systemd service name"),
    lines: z.number().optional().describe("Number of log lines to show (default: 50)")
  }),
  sidekick_archive: z.object({
    action: z.enum(["create", "extract", "list"]).describe("Archive action to perform"),
    path: z.string().describe("Source path (file/directory for create, archive for extract/list)"),
    output: z.string().optional().describe("Output path (required for create)"),
    format: z.string().optional().describe("Archive format: tar.gz, tgz, or zip (default: tar.gz)")
  }),
  sidekick_cron: z.object({
    action: z.enum(["add", "list", "remove", "run"]).describe("Cron action to perform"),
    name: z.string().optional().describe("Job name (required for add, optional for remove/run)"),
    schedule: z.string().optional().describe("Cron schedule expression (e.g. '0 * * * *' for hourly)"),
    command: z.string().optional().describe("Command to execute (required for add)"),
    id: z.string().optional().describe("Job ID (for remove/run)")
  }),
  sidekick_github: z.object({
    action: z.enum(["pr_list", "pr_create", "pr_get", "pr_merge", "issue_list", "issue_create", "issue_close", "commit_status", "release_create", "repo_info"]).describe("GitHub action to perform"),
    repo: z.string().describe("Repository in format 'owner/repo'"),
    args: z.string().optional().describe("Additional arguments (JSON string or value depending on action)")
  }),
  sidekick_webhook: z.object({
    action: z.enum(["list", "get", "clear"]).describe("Webhook action to perform"),
    id: z.string().optional().describe("Webhook ID (required for get)"),
    limit: z.number().optional().describe("Number of webhooks to list (default: 20)")
  }),
  sidekick_context: z.object({
    action: z.enum(["track_project", "track_decision", "track_problem", "track_pattern", "track_session", "recall", "suggest", "summarize", "list"]).describe("Context action to perform"),
    project: z.string().optional().describe("Project name (for tracking and filtering)"),
    context: z.string().optional().describe("Context description (for decisions/patterns)"),
    decision: z.string().optional().describe("Decision made (for track_decision)"),
    reasoning: z.string().optional().describe("Reasoning behind decision (for track_decision)"),
    problem: z.string().optional().describe("Problem description (for track_problem)"),
    solution: z.string().optional().describe("Solution to problem (for track_problem)"),
    pattern: z.string().optional().describe("Pattern description (for track_pattern)"),
    summary: z.string().optional().describe("Session summary (for track_session)"),
    topics: z.string().optional().describe("Comma-separated session topics (for track_session)"),
    outcome: z.string().optional().describe("Session outcome: success, partial, or abandoned (for track_session)"),
    notes: z.string().optional().describe("Additional session notes (for track_session)"),
    query: z.string().optional().describe("Search query (for recall/suggest)"),
    type: z.string().optional().describe("Context type: decisions, problems, patterns, projects, sessions, or all (default: all)"),
    limit: z.number().optional().describe("Maximum results to return (default: 10)")
  }),
  sidekick_teach: z.object({
    action: z.enum(["teach_procedure", "generate_tool", "learn_from_example", "execute", "list", "remove"]).describe("Teach action to perform"),
    name: z.string().optional().describe("Procedure name (required for teach/generate/execute/remove)"),
    description: z.string().optional().describe("Procedure description (required for teach/generate)"),
    steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()) })).optional().describe("Array of steps (required for teach_procedure)"),
    parameters: z.record(z.object({ type: z.enum(["string", "number", "boolean"]), description: z.string().optional(), required: z.boolean().optional() })).optional().describe("Parameter definitions for the procedure"),
    args: z.record(z.any()).optional().describe("Arguments to pass when executing a procedure"),
    example: z.string().optional().describe("Example to learn from (required for learn_from_example)"),
    trigger_phrases: z.array(z.string()).optional().describe("Trigger phrases for the procedure"),
    implementation: z.string().optional().describe("Implementation details (for generate_tool)")
  }),
  sidekick_transform: z.object({
    action: z.enum(["filter", "extract", "sort", "format", "map"]).describe("Transform action: filter (regex match), extract (field path), sort (array sort), format (convert format), map (add field)"),
    input: z.string().describe("Input data (text or JSON string)"),
    pattern: z.string().optional().describe("Regex pattern for filter action"),
    field: z.string().optional().describe("Field path for extract action (e.g. 'data.items[0].name')"),
    key: z.string().optional().describe("Key for sort action (object key) or map action (new field name)"),
    value: z.string().optional().describe("Value for map action (new field value)"),
    format: z.string().optional().describe("Output format for format action: json, csv, table, text")
  }),
  sidekick_health: z.object({
    check: z.enum(["all", "services", "processes", "disk", "network", "custom"]).describe("Health check type: all (services+processes+disk+network), services, processes, disk, network, or custom commands"),
    services: z.string().optional().describe("Comma-separated service names for services check (default: sidekick-mcp,sidekick-dashboard,sidekick-agent)"),
    commands: z.string().optional().describe("Comma-separated shell commands for custom check"),
    threshold: z.string().optional().describe("Alert thresholds (e.g. 'disk>90,mem>80')")
  }),
  sidekick_delay: z.object({
    action: z.enum(["add", "list", "cancel", "run"]).describe("Delay action: add (schedule new), list (show all), cancel (remove pending), run (execute immediately)"),
    id: z.string().optional().describe("Delay ID (required for cancel/run)"),
    when: z.string().optional().describe("When to execute: 10s, 5m, 2h, 1d, or ISO date string"),
    name: z.string().optional().describe("Human-readable name for the delay"),
    tool: z.string().optional().describe("Tool name to execute (for add action)"),
    args: z.record(z.any()).optional().describe("Arguments to pass to the tool (for add action)")
  }),
  sidekick_snapshot: z.object({
    action: z.enum(["capture", "compare", "list", "delete"]).describe("Snapshot action: capture (save state), compare (detect drift), list (show all), delete (remove)"),
    name: z.string().optional().describe("Snapshot name"),
    capture: z.string().optional().describe("What to capture: processes,services,disk,packages,network,files:/path (comma-separated)"),
    compare: z.string().optional().describe("Baseline snapshot name for compare action")
  }),
  sidekick_watch: z.object({
    action: z.enum(["add", "list", "remove", "pause", "check"]).describe("Watch action: add (create new), list (show all), remove (delete), pause (pause/resume), check (manual check)"),
    id: z.string().optional().describe("Watch ID (required for remove/pause/check)"),
    name: z.string().optional().describe("Human-readable watch name"),
    source: z.string().optional().describe("Watch source: service, process, endpoint, or file"),
    target: z.string().optional().describe("Watch target: service name, process name, URL, or file path"),
    condition: z.string().optional().describe("Trigger condition: status!=active, not_running, status!=200, content_matches, exists, not_exists"),
    interval: z.string().optional().describe("Check interval: 30s, 5m, 1h (default: 60s)"),
    action_tool: z.string().optional().describe("Tool to call when triggered (default: sidekick_notify)"),
    action_args: z.record(z.any()).optional().describe("Arguments for action tool"),
    pause: z.boolean().optional().describe("True to pause, false to resume")
  }),
  sidekick_secret: z.object({
    action: z.enum(["store", "get", "delete", "list", "rotate"]).describe("Secret action: store (save encrypted), get (retrieve), delete (remove), list (show names), rotate (generate new)"),
    key: z.string().optional().describe("Secret name/key"),
    value: z.string().optional().describe("Secret value (for store action)"),
    generate: z.string().optional().describe("Length for rotation (e.g. '32' for 32-char random hex)")
  }),
  sidekick_parse: z.object({
    input: z.string().describe("Data to parse (string content)"),
    format: z.string().optional().describe("Format: json, yaml, xml, ini, csv (auto-detected if not specified)")
  }),
  sidekick_diff: z.object({
    old_text: z.string().describe("Original content to compare"),
    new_text: z.string().describe("Modified content to compare"),
    type: z.string().optional().describe("Diff type: text, json, yaml, or auto (default: auto)"),
    format: z.string().optional().describe("Output format: unified, summary, or json (default: unified)")
  }),
  sidekick_hash: z.object({
    input: z.string().optional().describe("Data to hash (string content)"),
    path: z.string().optional().describe("File path to hash"),
    algorithm: z.string().optional().describe("Hash algorithm: md5, sha1, sha256, sha512 (default: sha256)"),
    verify: z.string().optional().describe("Expected hash value to verify against")
  }),
  sidekick_validate: z.object({
    data: z.union([z.string(), z.record(z.any())]).describe("Data to validate (JSON string or object)"),
    schema: z.union([z.string(), z.record(z.any())]).describe("JSON Schema (JSON string or object)")
  }),
  sidekick_template: z.object({
    template: z.string().describe("Handlebars template string"),
    data: z.union([z.string(), z.record(z.any())]).optional().describe("Template data (JSON string or object)")
  }),
  sidekick_queue: z.object({
    action: z.enum(["add", "list", "process", "remove", "clear"]).describe("Queue action"),
    id: z.number().optional().describe("Task ID (for remove action)"),
    tool: z.string().optional().describe("Tool name to queue (for add action)"),
    args: z.record(z.any()).optional().describe("Tool arguments (for add action)"),
    priority: z.number().optional().describe("Task priority, higher = more important (default: 0)"),
    status: z.string().optional().describe("Status filter for list/clear: pending, processing, completed, failed, or all")
  }),
  sidekick_retry: z.object({
    tool: z.string().describe("Tool name to retry"),
    args: z.record(z.any()).optional().describe("Tool arguments"),
    max_attempts: z.number().optional().describe("Maximum retry attempts (default: 3)"),
    backoff: z.enum(["exponential", "linear", "fixed"]).optional().describe("Backoff strategy (default: exponential)"),
    initial_delay: z.number().optional().describe("Initial delay in milliseconds (default: 1000)")
  }),
  sidekick_evolve: z.object({
    action: z.enum(["analyze", "propose", "list", "test", "approve", "reject", "report", "sync_docs", "cleanup"]).describe("Evolve action"),
    id: z.string().optional().describe("Proposal ID (for test/approve/reject)"),
    proposal: z.string().optional().describe("Proposal description (for propose) or 'auto' for LLM generation"),
    approve: z.boolean().optional().describe("Deprecated - use action=approve"),
    test: z.boolean().optional().describe("Deprecated - use action=test"),
    confirm: z.coerce.boolean().optional().describe("For cleanup action - actually delete old entries")
  }),
  sidekick_orchestrate: z.object({
    action: z.enum(["create", "execute", "list", "status", "cancel"]).describe("Orchestrate action"),
    id: z.number().optional().describe("Task ID (for execute/status/cancel)"),
    task_name: z.string().optional().describe("Task name (for create)"),
    subtasks: z.array(z.record(z.any())).optional().describe("Subtask definitions (for create)"),
    dependencies: z.record(z.array(z.string())).optional().describe("Dependency map (for create)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 1800000)")
  }),
  sidekick_predict: z.object({
    action: z.enum(["analyze", "list", "feedback", "suggest"]).describe("Predict action"),
    id: z.string().optional().describe("Prediction ID (for feedback)"),
    feedback: z.boolean().optional().describe("True if prediction was useful, false if not (for feedback)")
  }),
  sidekick_debug_tool: z.object({
    action: z.enum(["store", "recall", "cleanup", "start", "stop", "cache", "get", "status", "clear"]).describe("Debug action"),
    session_name: z.string().optional().describe("Session identifier (for legacy session actions)"),
    key: z.string().optional().describe("Cache key (for get/cache) or debug key (for cleanup)"),
    value: z.string().optional().describe("Value to cache/store"),
    service: z.string().optional().describe("Service name (for store/recall)"),
    issue: z.string().optional().describe("Issue description (for store)"),
    redact: z.boolean().optional().describe("Default true - set false to skip redaction")
  }),
  sidekick_fresheyes: z.object({
    problem: z.string().describe("Problem description"),
    context: z.string().optional().describe("Relevant context"),
    files: z.array(z.string()).optional().describe("Files analyzed"),
    hypotheses: z.array(z.string()).optional().describe("Current hypotheses"),
    full_response: z.boolean().optional().describe("Return full response vs key insights")
  }),
  sidekick_batch: z.object({
    calls: z.array(z.object({
      tool: z.string().describe("Tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments for the tool")
    })).describe("Array of tool calls to execute (max 20)")
  }),
  sidekick_cache: z.object({
    action: z.enum(["get", "set", "clear", "list"]).describe("Cache action"),
    key: z.string().optional().describe("Cache key"),
    ttl: z.string().optional().describe("Time-to-live: 30s, 5m, 1h (default: 5m)"),
    value: z.string().optional().describe("Value to cache (for set action)")
  }),
  sidekick_summarize: z.object({
    path: z.string().describe("File path to summarize"),
    max_lines: z.number().optional().describe("Maximum lines to return (default: 50)"),
    strategy: z.enum(["head", "tail", "grep", "stats"]).optional().describe("Summarization strategy (default: head)"),
    pattern: z.string().optional().describe("Regex pattern for grep strategy")
  }),
  sidekick_filter: z.object({
    path: z.string().describe("File or directory path to filter"),
    pattern: z.string().optional().describe("Regex pattern to match"),
    after: z.string().optional().describe("ISO date: include files modified after this date"),
    before: z.string().optional().describe("ISO date: include files modified before this date"),
    max_results: z.number().optional().describe("Maximum results to return (default: 50)")
  }),
  sidekick_project: z.object({
    name: z.string().describe("Project name"),
    include: z.string().optional().describe("Sections to include: kv,context,logs,procedures (default: kv,context)")
  }),
  sidekick_tail: z.object({
    source: z.string().describe("Source: log.jsonl, journalctl, or file path"),
    pattern: z.string().optional().describe("Regex filter (for journalctl: service name)"),
    lines: z.number().optional().describe("Number of lines to return (default: 50)"),
    since: z.string().optional().describe("Filter entries since this date (ISO or relative: 1h, 1d)")
  }),
  sidekick_diff_files: z.object({
    path_a: z.string().describe("First file path"),
    path_b: z.string().describe("Second file path"),
    format: z.enum(["unified", "summary"]).optional().describe("Output format (default: unified)")
  }),
  sidekick_find: z.object({
    path: z.string().describe("Directory to search in"),
    name: z.string().optional().describe("File name glob pattern (e.g. '*.js')"),
    modified_after: z.string().optional().describe("ISO date: files modified after"),
    modified_before: z.string().optional().describe("ISO date: files modified before"),
    size_min: z.string().optional().describe("Minimum file size (e.g. '1KB', '1MB')"),
    size_max: z.string().optional().describe("Maximum file size (e.g. '10MB')"),
    content: z.string().optional().describe("Regex pattern to match file contents"),
    max_results: z.number().optional().describe("Maximum results (default: 50)")
  }),
  sidekick_status: z.object({
    include: z.string().optional().describe("Sections: services,disk,memory,load,uptime,processes (default: services,disk)"),
    services: z.string().optional().describe("Comma-separated service names (default: sidekick-mcp,sidekick-dashboard,sidekick-agent)")
  }),
  sidekick_extract: z.object({
    path: z.string().describe("File path (JSON, YAML, INI, or XML)"),
    fields: z.union([z.string(), z.array(z.string())]).optional().describe("Field paths to extract (e.g. 'database.host,database.port')")
  }),
  sidekick_anonymize: z.object({
    action: z.enum(["anonymize", "patterns", "add_pattern", "remove_pattern"]),
    input: z.string().optional().describe("Text to anonymize"),
    format: z.enum(["text", "json", "yaml"]).optional().default("text"),
    custom_patterns: z.array(z.object({
      pattern: z.string(),
      replacement: z.string()
    })).optional(),
    consistency: z.boolean().optional().default(true).describe("Same input always maps to same output")
  }),
  sidekick_sandbox: z.object({
    action: z.enum(["exec", "rollback", "list", "diff", "clean"]),
    sandbox_name: z.string().optional(),
    command: z.string().optional().describe("Command to execute in sandbox"),
    files: z.array(z.string()).optional().describe("Files to auto-backup before exec"),
    auto_backup: z.boolean().optional().default(true),
    rollback_id: z.string().optional()
  }),
  sidekick_changelog: z.object({
    action: z.enum(["generate", "preview", "save"]),
    from: z.string().describe("Starting ref (tag, commit, branch)"),
    to: z.string().optional().default("HEAD"),
    format: z.enum(["markdown", "plain", "conventional"]).optional().default("markdown"),
    group_by: z.enum(["type", "scope", "author"]).optional().default("type"),
    use_llm: z.boolean().optional().default(false),
    include: z.enum(["all", "features", "fixes", "breaking", "refactor", "deps"]).optional().default("all"),
    path: z.string().optional().describe("Git repository path (default: current directory)")
  }),
  sidekick_netdiag: z.object({
    action: z.enum(["check", "dns", "route", "ports", "listeners", "connectivity"]),
    target: z.string().describe("Host, URL, or IP to diagnose"),
    port_range: z.string().optional().describe("Port range for scan (e.g., '80-443')"),
    timeout: z.number().optional().default(5000),
    format: z.enum(["detailed", "compact", "json"]).optional().default("detailed")
  }),
  sidekick_timeline: z.object({
    action: z.enum(["build", "filter", "export"]),
    since: z.string().describe("Start time (ISO or relative: 1h, 1d, 7d)"),
    until: z.string().optional().default("now"),
    sources: z.array(z.enum(["log.jsonl", "journalctl", "git", "files", "all"])).optional().default(["all"]),
    pattern: z.string().optional().describe("Regex filter for event content"),
    severity: z.enum(["error", "warn", "info", "all"]).optional().default("all"),
    format: z.enum(["compact", "detailed", "json"]).optional().default("compact"),
    max_events: z.number().optional().default(200)
  }),
  sidekick_circuit: z.object({
    action: z.enum(["call", "status", "reset", "configure"]),
    target: z.string().describe("Circuit target label (e.g., 'github-api', 'web-fetch')"),
    tool: z.string().optional().describe("Tool name to call (for action=call)"),
    args: z.record(z.any()).optional().describe("Tool arguments (for action=call)"),
    failure_threshold: z.number().optional().default(5),
    cooldown_seconds: z.number().optional().default(60),
    cache_response: z.boolean().optional().default(false)
  }),
  sidekick_baseline: z.object({
    action: z.enum(["record", "learn", "check", "status", "reset"]),
    metric_name: z.string().describe("Metric identifier"),
    value: z.number().optional().describe("Value to record (for action=record)"),
    source: z.string().optional().describe("Data source: 'health', 'custom', 'command'"),
    command: z.string().optional().describe("Command to collect metric (for source=command)"),
    window: z.string().optional().default("7d").describe("History window to analyze"),
    sensitivity: z.enum(["low", "medium", "high"]).optional().default("medium")
  }),
  sidekick_depend: z.object({
    action: z.enum(["tree", "reverse", "outdated", "impact", "orphans"]),
    type: z.enum(["npm", "service", "process"]),
    target: z.string().optional().describe("Package, service, or PID to analyze"),
    depth: z.number().optional().default(5),
    format: z.enum(["tree", "flat", "json"]).optional().default("tree")
  }),
  sidekick_runbook: z.object({
    action: z.enum(["create", "start", "next", "verify", "rollback", "abort", "list", "get", "delete"]),
    name: z.string().optional(),
    mode: z.enum(["autonomous", "guided"]).optional().default("autonomous"),
    steps: z.array(z.object({
      name: z.string(),
      command: z.string(),
      expected: z.string().optional().describe("Expected output pattern (regex)"),
      rollback: z.string().optional().describe("Rollback command if this step fails"),
      verify_command: z.string().optional().describe("Verification command to run after")
    })).optional(),
    runbook_id: z.string().optional(),
    step_index: z.number().optional()
  }),
  sidekick_black_box: z.object({
    action: z.enum(["capture", "list", "get", "delete", "analyze"]),
    name: z.string().optional().describe("Incident name/identifier"),
    include: z.array(z.enum(["services", "processes", "logs", "disk", "network", "all"])).optional().default(["all"]),
    analyze_with_llm: z.boolean().optional().default(false),
    incident_id: z.string().optional()
  }),
  sidekick_respond: z.object({
    text: z.string().describe("The response text to return")
  }),
  sidekick_db_schema: z.object({
    table: z.string().optional().describe("Specific table name (optional)"),
    verbose: z.boolean().optional().describe("Include row counts and detailed info"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  sidekick_db_query: z.object({
    sql: z.string().describe("SQL query to execute"),
    params: z.array(z.any()).optional().describe("Query parameters"),
    readonly: z.boolean().optional().default(true).describe("Read-only mode (blocks writes)"),
    limit: z.number().optional().default(1000).describe("Maximum rows to return"),
    timeout: z.number().optional().default(5000).describe("Query timeout in milliseconds"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  sidekick_db_stats: z.object({
    detailed: z.boolean().optional().describe("Include per-table statistics"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  sidekick_db_backup: z.object({
    path: z.string().optional().describe("Output path (default: data/backups/)"),
    compress: z.boolean().optional().default(true).describe("Gzip compression")
  }),
  sidekick_db_restore: z.object({
    path: z.string().describe("Backup file path"),
    verify: z.boolean().optional().default(true).describe("Check integrity before restore")
  }),
  sidekick_log_query: z.object({
    tool: z.string().optional().describe("Filter by tool name"),
    source: z.string().optional().describe("Filter by source: mcp/agent/dashboard"),
    success: z.boolean().optional().describe("Filter by success status"),
    since: z.string().optional().describe("Start time (ISO or relative: 1h, 1d)"),
    until: z.string().optional().describe("End time (ISO timestamp)"),
    limit: z.number().optional().default(100).describe("Maximum results")
  }),
  sidekick_db_export: z.object({
    table: z.string().optional().describe("Specific table (exports all if omitted)"),
    format: z.enum(["json", "csv", "sql"]).optional().default("json").describe("Export format"),
    path: z.string().optional().describe("Output file path"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  sidekick_db_search: z.object({
    query: z.string().describe("Search terms"),
    tables: z.string().optional().describe("Comma-separated table names"),
    limit: z.number().optional().default(50).describe("Maximum results"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  sidekick_db_migrate: z.object({
    action: z.enum(["status", "list", "up"]).describe("Migration action"),
    version: z.number().optional().describe("Target version"),
    name: z.string().optional().describe("Migration filename (for up action)")
  }),
  sidekick_db_diff: z.object({
    snapshot_a: z.string().optional().describe("Path to snapshot A or 'current'"),
    snapshot_b: z.string().optional().describe("Path to snapshot B or 'current'"),
    table: z.string().optional().describe("Specific table to compare")
  }),
  sidekick_redis: z.object({
    action: z.enum(["get", "set", "del", "keys", "ttl", "info", "flush"]).describe("Redis action"),
    key: z.string().optional().describe("Redis key"),
    value: z.string().optional().describe("Value for set action"),
    ttl: z.string().optional().describe("TTL in seconds for set action"),
    pattern: z.string().optional().describe("Pattern for keys action (default '*')")
  }),
  sidekick_ocr: z.object({
    path: z.string().describe("Image file path"),
    language: z.string().optional().default("eng").describe("OCR language (default: eng)"),
    psm: z.number().optional().describe("Page segmentation mode")
  }),
  sidekick_media: z.object({
    action: z.enum(["info", "convert", "extract_audio", "thumbnail", "resize", "trim"]).describe("Media action"),
    input: z.string().describe("Input file path"),
    output: z.string().optional().describe("Output file path"),
    options: z.string().optional().describe("Format-specific options")
  }),
  sidekick_transcribe: z.object({
    path: z.string().describe("Audio/video file path"),
    model: z.string().optional().default("base").describe("Whisper model (tiny|base|small|medium)"),
    language: z.string().optional().describe("Language code")
  }),
  sidekick_analytics: z.object({
    query: z.string().optional().describe("SQL query"),
    file: z.string().optional().describe("Data file path (CSV, JSON, or Parquet)"),
    format: z.string().optional().describe("File format (csv|json|parquet)")
  }),
  sidekick_embed: z.object({
    text: z.string().describe("Text to embed"),
    model: z.string().optional().default("nomic-embed-text").describe("Embedding model")
  }),
  sidekick_ollama: z.object({
    action: z.enum(["list", "ps", "pull", "show"]).describe("Ollama action"),
    model: z.string().optional().describe("Model name (required for pull/show)")
  }),
  sidekick_tunnel: z.object({
    action: z.enum(["start", "stop", "list"]).describe("Tunnel action"),
    port: z.number().optional().describe("Local port to expose (required for start)"),
    name: z.string().optional().describe("Tunnel name (optional)")
  }),
  sidekick_download: z.object({
    url: z.string().describe("Video URL"),
    output: z.string().optional().describe("Output path"),
    format: z.string().optional().describe("Video format"),
    audio_only: z.boolean().optional().describe("Extract audio only")
  }),
  sidekick_wireguard: z.object({
    action: z.enum(["status", "list_peers", "add_peer", "remove_peer", "generate_keypair"]).describe("WireGuard action"),
    interface_name: z.string().optional().describe("WireGuard interface (e.g. wg0)"),
    peer_name: z.string().optional().describe("Peer name (for add_peer)"),
    public_key: z.string().optional().describe("Peer public key"),
    endpoint: z.string().optional().describe("Peer endpoint IP:port"),
    allowed_ips: z.string().optional().describe("Allowed IPs (default 10.0.0.0/24)")
  }),
  sidekick_nginx: z.object({
    action: z.enum(["status", "list_sites", "add_site", "remove_site", "test_config", "reload"]).describe("Nginx action"),
    site_name: z.string().optional().describe("Site config name"),
    domain: z.string().optional().describe("Domain name (for add_site)"),
    upstream_port: z.number().optional().describe("Local port to proxy to"),
    ssl_email: z.string().optional().describe("Email for Let's Encrypt")
  }),
  sidekick_knowledge: z.object({
    action: z.enum(["search", "get", "list", "add", "update", "delete"]).describe("Knowledge base action"),
    id: z.number().optional().describe("Entry ID (for get/update/delete)"),
    category: z.string().optional().describe("Category (for list/add/update)"),
    title: z.string().optional().describe("Title (for add/update)"),
    content: z.string().optional().describe("Content (for add/update)"),
    tags: z.string().optional().describe("Comma-separated tags (for add/update)"),
    query: z.string().optional().describe("Search query (for search)"),
    limit: z.number().optional().describe("Max results (for search/list)")
  }),
};

// --- Factory: create fresh McpServer + register tools ---

function buildProcedureSchema(parameters) {
  const shape = {};
  for (const [key, def] of Object.entries(parameters || {})) {
    let field;
    if (def.type === "number") {
      field = z.number().describe(def.description || key);
    } else if (def.type === "boolean") {
      field = z.boolean().describe(def.description || key);
    } else {
      field = z.string().describe(def.description || key);
    }
    if (!def.required) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return z.object(shape);
}

function createMcpServer() {
  const server = new McpServer({
    name: "sidekick-mcp-server",
    version: "1.0.0"
  }, {
    capabilities: { tools: {} }
  });

  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, {
      description: def.description,
      inputSchema: TOOL_SCHEMAS[def.name]
    }, async (args, extra) => {
      setSource("mcp");
      const start = Date.now();
      try {
        const policyError = enforceToolPolicy(def.name, "mcp");
        if (policyError) {
          logToolCall(def.name, args, Date.now() - start, false, policyError.content[0].text);
          return policyError;
        }
        const result = await TOOLS[def.name](args);
        logToolCall(def.name, args, Date.now() - start, !result.isError,
          result.content?.[0]?.text?.substring(0, 80) || "(ok)"
        );
        return result;
      } catch (e) {
        logToolCall(def.name, args, Date.now() - start, false, e.message);
        throw e;
      }
    });
  }

  const procedures = loadProcedures();
  for (const [procName, proc] of Object.entries(procedures)) {
    const toolName = "sidekick_" + procName;
    if (TOOL_SCHEMAS[toolName]) continue;
    const paramSchema = buildProcedureSchema(proc.parameters);
    const paramNames = Object.keys(proc.parameters || {});
    const paramDesc = paramNames.length > 0 ? ` Parameters: ${paramNames.join(", ")}.` : "";
    server.registerTool(toolName, {
      description: `[procedure] ${proc.description}${paramDesc}`,
      inputSchema: paramSchema
    }, async (args, extra) => {
      setSource("mcp");
      const start = Date.now();
      try {
        const policyError = enforceToolPolicy("sidekick_teach", "mcp");
        if (policyError) {
          logToolCall(toolName, args, Date.now() - start, false, policyError.content[0].text);
          return policyError;
        }
        const result = await TOOLS.sidekick_teach({ action: "execute", name: procName, args });
        logToolCall(toolName, args, Date.now() - start, !result.isError,
          result.content?.[0]?.text?.substring(0, 80) || "(ok)"
        );
        return result;
      } catch (e) {
        logToolCall(toolName, args, Date.now() - start, false, e.message);
        throw e;
      }
    });
  }

  return server;
}

// --- Session management: one McpServer + Transport pair per session ---

const sessions = new Map();
const staleSessionMap = new Map(); // staleId -> { replacementId, createdAt }
const serverStartTime = Date.now();

function generateSessionId() {
  return "sess-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function getTransportForRequest(sessionId, metadata = {}) {
  logDebug("getTransportForRequest", { requestedSessionId: sessionId, sessionCount: sessions.size });
  
  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId);
    const age = Date.now() - entry.createdAt;
    const idle = Date.now() - entry.lastAccess;
    entry.lastAccess = Date.now();
    logDebug("REUSE_SESSION", { sessionId, age_ms: age, idle_ms: idle });
    return { transport: entry.transport, isNew: false };
  }

  if (sessionId && !sessions.has(sessionId)) {
    const staleEntry = staleSessionMap.get(sessionId);
    const replacementId = staleEntry?.replacementId;
    if (replacementId && sessions.has(replacementId)) {
      logDebug("STALE_SESSION_KNOWN_REPLACEMENT", { staleSessionId: sessionId, replacementId });
      return { transport: null, isNew: false, newSessionId: replacementId, staleRedirect: true };
    }

    logDebug("STALE_SESSION_CREATING_REPLACEMENT", { staleSessionId: sessionId, sessionCount: sessions.size });

    const newSessionId = generateSessionId();
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableJsonResponse: true
    });

    registerSession(newSessionId, server, transport, metadata);
    await server.connect(transport);

    // Auto-initialize replacement sessions so they're ready for immediate use
    try {
      const initReq = new Request("http://127.0.0.1:4097/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "mcp-session-id": newSessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "sidekick-auto-init", version: "1.0" }
          }
        })
      });
      await transport.handleRequest(initReq);
      markSessionInitialized(newSessionId);
      logDebug("AUTO_INITIALIZED_REPLACEMENT", { staleSessionId: sessionId, newSessionId });
    } catch (initError) {
      logDebug("AUTO_INIT_FAILED", { newSessionId, error: initError.message });
    }

    staleSessionMap.set(sessionId, { replacementId: newSessionId, createdAt: Date.now() });
    if (staleSessionMap.size > 100) {
      const firstKey = staleSessionMap.keys().next().value;
      staleSessionMap.delete(firstKey);
    }

    logDebug("CREATED_REPLACEMENT_SESSION", { staleSessionId: sessionId, newSessionId });
    return { transport: null, isNew: true, newSessionId, staleRedirect: true };
  }

  const newSessionId = generateSessionId();
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    enableJsonResponse: true
  });

  registerSession(newSessionId, server, transport, metadata);
  await server.connect(transport);

  // Auto-initialize fresh sessions so they're ready for immediate use
  try {
    const initReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": newSessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "sidekick-auto-init", version: "1.0" }
        }
      })
    });
    await transport.handleRequest(initReq);
    markSessionInitialized(newSessionId);
    logDebug("AUTO_INITIALIZED_FRESH", { newSessionId });
  } catch (initError) {
    logDebug("AUTO_INIT_FAILED", { newSessionId, error: initError.message });
  }

  logDebug("CREATED_NEW_TRANSPORT", { newSessionId });
  return { transport, isNew: true, newSessionId };
}

function registerSession(sessionId, server, transport, metadata = {}) {
  logDebug("REGISTER_SESSION", { sessionId, sessionCount: sessions.size + 1, userAgent: metadata.userAgent, clientInfo: metadata.clientInfo });
  sessions.set(sessionId, {
    server,
    transport,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    initialized: false,
    userAgent: metadata.userAgent || null,
    clientInfo: metadata.clientInfo || null
  });
}

function markSessionInitialized(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.initialized = true;
    logDebug("SESSION_INITIALIZED", { sessionId });
  }
}

// Cleanup sessions inactive for more than 1 hour, every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  const evicted = [];
  for (const [id, entry] of sessions) {
    if (entry.lastAccess < cutoff) {
      evicted.push({ sessionId: id, age_ms: Date.now() - entry.createdAt, idle_ms: Date.now() - entry.lastAccess, userAgent: entry.userAgent });
      sessions.delete(id);
    }
  }
  if (evicted.length > 0) {
    logDebug("SESSION_CLEANUP", { evicted, remaining: sessions.size });
  }
}, 600000);

// Cleanup stale session mappings older than 30 minutes, every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 1800000;
  const evicted = [];
  for (const [staleId, entry] of staleSessionMap) {
    if (entry.createdAt < cutoff) {
      evicted.push({ staleSessionId: staleId, replacementId: entry.replacementId, age_ms: Date.now() - entry.createdAt });
      staleSessionMap.delete(staleId);
    }
  }
  if (evicted.length > 0) {
    logDebug("STALE_SESSION_CLEANUP", { evicted, remaining: staleSessionMap.size });
  }
}, 300000);

// --- Express app ---

const app = express();

function getBearerOrQueryToken(req) {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  }
  return typeof req.query.api_key === "string" ? req.query.api_key : null;
}

if (ALLOWED_IPS.length) {
  app.use((req, res, next) => {
    const ip = req.ip === "::ffff:127.0.0.1" ? "127.0.0.1" : req.ip;
    if (ip === "127.0.0.1" || ip === "::1" || ALLOWED_IPS.some(entry => ipInRange(ip, entry))) {
      return next();
    }
    return res.status(403).json({ error: "Forbidden" });
  });
}

app.get("/health", (req, res) => {
  const uptimeMs = Date.now() - serverStartTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  const includeDetails = timingSafeCompare(getBearerOrQueryToken(req), API_KEY);

  const payload = {
    status: "healthy",
    uptime: uptimeSeconds,
    uptimeHuman: uptimeStr,
    sessions: sessions.size,
    staleMappings: staleSessionMap.size,
    version: "1.0.0",
    timestamp: new Date().toISOString()
  };

  if (includeDetails) {
    payload.sessionDetails = Array.from(sessions.entries()).map(([id, entry]) => ({
      id,
      age: Date.now() - entry.createdAt,
      idle: Date.now() - entry.lastAccess,
      initialized: entry.initialized,
      userAgent: entry.userAgent,
      clientInfo: entry.clientInfo
    }));
  }

  res.json(payload);
});

app.use((req, res, next) => {
  const token = getBearerOrQueryToken(req);
  if (!timingSafeCompare(token, API_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

// --- Legacy SSE routes (for clients like opencode) ---

app.get("/sse", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    
    const sessionId = transport.sessionId;
    const metadata = {
      userAgent: req.headers["user-agent"],
      clientInfo: null
    };
    registerSession(sessionId, server, transport, metadata);
    await server.connect(transport);
    
    console.log(`[SSE] New session: ${sessionId} from ${metadata.userAgent || "unknown"}`);
  } catch (e) {
    console.error("[SSE] Error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.post("/messages", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: "Invalid session" });
    }
    
    const entry = sessions.get(sessionId);
    const transport = entry.transport;
    if (!(transport instanceof SSEServerTransport)) {
      return res.status(400).json({ error: "Not an SSE session" });
    }
    
    entry.lastAccess = Date.now();
    await transport.handlePostMessage(req, res, req.body);
  } catch (e) {
    console.error("[SSE POST] Error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// --- Diagnostic logging ---

function logSession(method, headers, body) {
  const sessionId = headers["mcp-session-id"] || headers["Mcp-Session-Id"] || "none";
  const methodType = body ? (typeof body === "object" ? body.method : "unknown") : "unknown";
  console.log(`[MCP ${method}] session=${sessionId} method=${methodType}`);
}

// --- MCP routes ---

app.post("/mcp", async (req, res) => {
  try {
    const body = typeof req.body === "object" ? JSON.stringify(req.body) : req.body || "";
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("POST", wh, req.body);

    const metadata = {
      userAgent: wh["user-agent"],
      clientInfo: req.body?.params?.clientInfo || null
    };
    const { transport, isNew, newSessionId, staleRedirect } = await getTransportForRequest(sessionId, metadata);

    if (staleRedirect) {
      logDebug("STALE_SESSION_RETURNING_REINIT", { staleSessionId: sessionId, newSessionId });
      res.status(400);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("mcp-session-id", newSessionId);
      res.json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session expired. A new session has been created. Please re-initialize using the session ID from the mcp-session-id response header. If this persists, check server logs for initialization errors." },
        id: null
      });
      return;
    }

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "POST",
      headers: wh,
      body: body
    });

    const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });

    if (isNew && newSessionId) {
      logDebug("NEW_SESSION_HANDLED", { newSessionId });
    }

    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP error:", e.message);
    logDebug("MCP_POST_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/mcp", async (req, res) => {
  try {
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("GET", wh, null);

    if (!sessionId || !sessions.has(sessionId)) {
      logDebug("GET_WITHOUT_SESSION", { sessionId });
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "GET requires a valid mcp-session-id header" },
        id: null
      });
    }

    const { transport } = await getTransportForRequest(sessionId);

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "GET",
      headers: wh
    });

    const webRes = await transport.handleRequest(webReq);

    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    if (webRes.body) {
      const reader = webRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(Buffer.from(value));
        }
      };
      await pump();
    } else {
      res.end();
    }
  } catch (e) {
    console.error("MCP GET error:", e.message);
    logDebug("MCP_GET_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.delete("/mcp", async (req, res) => {
  try {
    const wh = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") wh[k] = v;
    }
    const sessionId = wh["mcp-session-id"] || wh["Mcp-Session-Id"];
    logSession("DELETE", wh, null);

    if (!sessionId || !sessions.has(sessionId)) {
      logDebug("DELETE_WITHOUT_SESSION", { sessionId });
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "DELETE requires a valid mcp-session-id header" },
        id: null
      });
    }

    const { transport } = await getTransportForRequest(sessionId);

    const webReq = new Request("http://127.0.0.1:4097/mcp", {
      method: "DELETE",
      headers: wh
    });

    const webRes = await transport.handleRequest(webReq);

    if (sessionId && sessions.has(sessionId)) {
      sessions.delete(sessionId);
      logDebug("SESSION_DELETED", { sessionId });
    }

    res.status(webRes.status);
    webRes.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
    const text = await webRes.text();
    if (text) res.send(text);
    else res.end();
  } catch (e) {
    console.error("MCP DELETE error:", e.message);
    logDebug("MCP_DELETE_ERROR", { error: e.message, stack: e.stack, sessionId: req.headers["mcp-session-id"] });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Run pending migrations automatically on startup
try {
  const migrationResult = dbStore.runPendingMigrations();
  if (migrationResult.applied > 0) {
    console.log(`[Migration] Applied ${migrationResult.applied} migration(s):`, migrationResult.migrations.map(m => m.file).join(', '));
  }
} catch (error) {
  console.error('[Migration] Error running migrations:', error.message);
}

// Sync tool registry from code to database on startup
syncToolRegistry();

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sidekick MCP server listening on port " + PORT);
  console.log("MCP endpoint: http://0.0.0.0:" + PORT + "/mcp");
  console.log("Data dir: " + DATA_DIR);
});
