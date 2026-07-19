const { z } = require("zod");

const TOOL_SCHEMAS = {
  bash: z.object({ command: z.string().describe("Shell command to execute") }),
  tools: z.object({
    action: z.enum(["overview", "search", "get", "policy"]).optional().default("overview").describe("Catalog action"),
    query: z.string().optional().describe("Search terms for action=search"),
    name: z.string().optional().describe("Tool name for action=get or action=policy"),
    category: z.string().optional().describe("Filter by category"),
    source: z.string().optional().describe("Comma-separated source list for action=policy, e.g. mcp,dashboard,agent"),
    format: z.enum(["text", "json"]).optional().default("text").describe("Output format"),
    include_disabled: z.boolean().optional().describe("Include policy-disabled tools"),
    limit: z.number().optional().describe("Max search results")
  }),
  read: z.object({ path: z.string().describe("Absolute path to the file to read") }),
  write: z.object({ path: z.string().describe("Absolute path to write to"), content: z.string().describe("File content to write") }),
  store: z.object({
    key: z.string().describe("Storage key"),
    value: z.string().describe("Value to store"),
    project: z.string().optional().describe("Project name (lowercase, underscores only)"),
    category: z.string().optional().describe("Category tag for filtering (e.g. 'mcp', 'tool', 'config')")
  }),
  get: z.object({ key: z.string().describe("Storage key to retrieve") }),
  delete: z.object({ key: z.string().describe("Storage key to delete") }),
  resume: z.object({
    action: z.enum(["check", "set", "clear", "list"]).optional().default("check").describe("Resume action"),
    project: z.string().optional().describe("Project name for check/set/clear"),
    summary: z.string().optional().describe("Short pending-work summary for action=set"),
    next_step: z.string().optional().describe("Concrete next step for action=set"),
    status: z.string().optional().describe("Resume status for action=set (default active)"),
    branch: z.string().optional().describe("Related branch name for action=set"),
    url: z.string().optional().describe("Related PR/issue URL for action=set"),
    notes: z.string().optional().describe("Additional notes for set/clear"),
    plan_name: z.string().optional().describe("Descriptive handoff plan name for action=set"),
    current_phase: z.number().int().positive().optional().describe("Current phase number within the named plan for action=set"),
    include_cleared: z.boolean().optional().describe("Include cleared/done items for action=list"),
    format: z.enum(["text", "json"]).optional().default("text").describe("Output format")
  }),
  list: z.object({ path: z.string().optional().default("/home/sidekick").describe("Directory path to list") }),
  web_fetch: z.object({
    url: z.string().describe("URL to fetch"),
    method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method"),
    headers: z.string().optional().describe("JSON object of extra headers"),
    body: z.string().optional().describe("Request body (for POST)")
  }),
  llm: z.object({
    prompt: z.string().describe("The prompt to send to the LLM"),
    system: z.string().optional().describe("System prompt override"),
    temperature: z.number().optional().default(0.7).describe("Sampling temperature (0-2)"),
    provider: z.string().optional().describe("LLM provider: 'ollama' (default) or 'groq' (cloud)")
  }),
  list_projects: z.object({}),
  get_by_project: z.object({ project: z.string().describe("Project name to filter by") }),
  search: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("Directory to search in (defaults to current directory)"),
    include: z.string().optional().describe("File pattern to include (e.g. '*.js', '*.ts')")
  }),
  git: z.object({
    action: z.enum(["status", "diff", "log", "add", "commit", "push", "pull", "branch", "checkout", "stash"]).describe("Git action to perform"),
    path: z.string().optional().describe("Repository path (defaults to current directory)"),
    args: z.string().optional().describe("Additional arguments for the git command")
  }),
  notify: z.object({
    channel: z.enum(["discord", "slack", "email"]).describe("Notification channel"),
    webhook_url: z.string().optional().describe("Webhook URL (required for discord/slack)"),
    recipient: z.string().optional().describe("Email recipient (required for email)"),
    message: z.string().describe("Message content to send"),
    title: z.string().optional().describe("Optional title/subject")
  }),
  process: z.object({
    action: z.enum(["list", "top", "kill", "tree"]).describe("Process action to perform"),
    filter: z.string().optional().describe("Filter processes by name (for list action)"),
    pid: z.number().optional().describe("Process ID to kill"),
    name: z.string().optional().describe("Process name to kill (alternative to pid)"),
    signal: z.string().optional().describe("Signal to send when killing (default: TERM)")
  }),
  service: z.object({
    action: z.enum(["start", "stop", "restart", "status", "enable", "disable", "logs"]).describe("Service action to perform"),
    service: z.string().describe("Systemd service name"),
    lines: z.number().optional().describe("Number of log lines to show (default: 50)")
  }),
  archive: z.object({
    action: z.enum(["create", "extract", "list"]).describe("Archive action to perform"),
    path: z.string().describe("Source path (file/directory for create, archive for extract/list)"),
    output: z.string().optional().describe("Output path (required for create)"),
    format: z.string().optional().describe("Archive format: tar.gz, tgz, or zip (default: tar.gz)")
  }),
  cron: z.object({
    action: z.enum(["add", "list", "remove", "run"]).describe("Cron action to perform"),
    name: z.string().optional().describe("Job name (required for add, optional for remove/run)"),
    schedule: z.string().optional().describe("Cron schedule expression (e.g. '0 * * * *' for hourly)"),
    command: z.string().optional().describe("Command to execute (required for add)"),
    id: z.string().optional().describe("Job ID (for remove/run)")
  }),
  github: z.object({
    action: z.enum(["pr_list", "pr_create", "pr_get", "pr_merge", "issue_list", "issue_create", "issue_close", "commit_status", "release_create", "repo_info"]).describe("GitHub action to perform"),
    repo: z.string().describe("Repository in format 'owner/repo'"),
    args: z.string().optional().describe("Additional arguments (JSON string or value depending on action)")
  }),
  ci_status: z.object({
    repo: z.string().describe("Repository in format 'owner/repo'"),
    pr: z.union([z.string(), z.number()]).optional().describe("Pull request number"),
    pull_number: z.union([z.string(), z.number()]).optional().describe("Pull request number"),
    sha: z.string().optional().describe("Commit SHA"),
    commit: z.string().optional().describe("Commit SHA"),
    ref: z.string().optional().describe("Git ref, branch, or SHA"),
    branch: z.string().optional().describe("Branch name"),
    format: z.enum(["text", "json"]).optional().describe("Output format (text or json, default text)")
  }),
  webhook: z.object({
    action: z.enum(["list", "get", "clear"]).describe("Webhook action to perform"),
    id: z.string().optional().describe("Webhook ID (required for get)"),
    limit: z.number().optional().describe("Number of webhooks to list (default: 20)")
  }),
  context: z.object({
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
    type: z.string().optional().describe("Context type: decisions, problems, patterns, projects, sessions, memories, or all (default: all)"),
    limit: z.number().optional().describe("Maximum results to return (default: 10)")
  }),
  session: z.object({
    action: z.enum(["begin", "update", "checkpoint", "end", "abandon", "resume", "status", "list"]).describe("Session action"),
    id: z.string().optional().describe("Task/session ID"),
    goal: z.string().optional().describe("Task goal, required for begin"),
    project: z.string().optional().describe("Project scope"),
    source: z.string().optional().describe("Client/source label"),
    working_directory: z.string().optional(),
    repository: z.string().optional(),
    branch: z.string().optional(),
    environment: z.string().optional(),
    client_session_id: z.string().optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
    supplied_context: z.string().optional(),
    current_plan: z.string().optional(),
    completed_steps: z.array(z.any()).optional(),
    current_hypothesis: z.string().optional(),
    evidence: z.union([z.string(), z.array(z.string())]).optional(),
    blockers: z.array(z.any()).optional(),
    next_step: z.string().optional(),
    artifacts: z.array(z.any()).optional(),
    outcome: z.string().optional(),
    final_summary: z.string().optional(),
    user_visible_result: z.string().optional(),
    acceptance_state: z.string().optional(),
    decisions: z.array(z.string()).optional(),
    verified_facts: z.array(z.string()).optional(),
    unresolved_issues: z.array(z.string()).optional(),
    resolved_issues: z.array(z.string()).optional(),
    failed_approaches: z.array(z.string()).optional(),
    procedures_learned: z.array(z.string()).optional(),
    follow_ups: z.array(z.string()).optional(),
    usefulness_feedback: z.string().optional(),
    limit: z.number().optional()
  }),
  handoff: z.object({
    action: z.enum(["create", "update", "get", "list", "compare", "inspect", "reprocess", "archive"]).describe("Handoff action"),
    id: z.string().optional(),
    key: z.string().optional().describe("KV key for backward-compatible handoffs"),
    project: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    source: z.string().optional(),
    task_id: z.string().optional(),
    reprocess: z.boolean().optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().optional()
  }),
  memory: z.object({
    action: z.enum(["remember", "query", "explain", "list", "get", "confirm", "correct", "forget", "pin", "expire", "conflicts", "health", "backfill"]).describe("Memory action"),
    id: z.string().optional(),
    project: z.string().optional(),
    type: z.string().optional(),
    memory_class: z.string().optional(),
    content: z.string().optional(),
    summary: z.string().optional(),
    scope_type: z.string().optional(),
    scope_id: z.string().optional(),
    source: z.string().optional(),
    evidence: z.string().optional(),
    confidence: z.number().optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
    query: z.string().optional(),
    limit: z.number().optional(),
    reason: z.string().optional(),
    correct_to: z.string().optional(),
    fresh_eyes: z.boolean().optional(),
    historical: z.boolean().optional()
  }),
  memory_export: z.object({
    project: z.string().optional().describe("Filter by project name"),
    type: z.string().optional().describe("Filter by memory type (fact, decision, preference, etc.)"),
    include_disabled: z.boolean().optional().describe("Include disabled memories (default: true)"),
    automatic_only: z.boolean().optional().describe("Only include automatic memories (default: false)")
  }),
  memory_import: z.object({
    data: z.string().describe("JSON export data (string or object)"),
    on_conflict: z.enum(["merge", "skip"]).optional().describe("Conflict resolution: merge (update existing) or skip (default: merge)"),
    preserve_ids: z.boolean().optional().describe("Preserve original memory IDs (default: false)")
  }),
  memory_manage: z.object({
    action: z.enum(["confirm", "set_requires_confirmation", "delete", "disable", "expire", "restore", "set_auto_expire", "list_by_state", "pending_confirmations", "process_auto_expirations"]).describe("Action to perform"),
    id: z.string().optional().describe("Memory ID (or state name for list_by_state)"),
    confirmed_by: z.string().optional().describe("Who confirmed (for confirm action - default 'user')"),
    days: z.number().optional().describe("Days until expiration (for set_auto_expire)"),
    reason: z.string().optional().describe("Reason for delete/expire"),
    limit: z.number().optional().describe("Limit for list operations (default 50)"),
    project: z.string().optional().describe("Filter by project for list operations")
  }),
  sync_identity: z.object({
    action: z.enum(["get", "set_user"]).describe("Action: get (show identity) or set_user (set user ID)"),
    user_id: z.string().optional().describe("User ID to set (required for set_user action)")
  }),
  sync_export: z.object({
    project: z.string().optional().describe("Filter by project name"),
    since: z.string().optional().describe("ISO timestamp - only export memories updated after this time"),
    include_disabled: z.boolean().optional().describe("Include disabled memories (default: true)")
  }),
  sync_import: z.object({
    data: z.string().describe("Sync export data from another machine (JSON string or object)"),
    strategy: z.enum(["newest", "highest_confidence", "most_confirmed", "merge", "skip"]).optional().describe("Conflict resolution strategy (default: newest)"),
    preserve_ids: z.boolean().optional().describe("Preserve original memory IDs (default: false)")
  }),
  sync_diff: z.object({
    since: z.string().describe("ISO timestamp - get changes after this time")
  }),
  teach: z.object({
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
  transform: z.object({
    action: z.enum(["filter", "extract", "sort", "format", "map"]).describe("Transform action: filter (regex match), extract (field path), sort (array sort), format (convert format), map (add field)"),
    input: z.string().describe("Input data (text or JSON string)"),
    pattern: z.string().optional().describe("Regex pattern for filter action"),
    field: z.string().optional().describe("Field path for extract action (e.g. 'data.items[0].name')"),
    key: z.string().optional().describe("Key for sort action (object key) or map action (new field name)"),
    value: z.string().optional().describe("Value for map action (new field value)"),
    format: z.string().optional().describe("Output format for format action: json, csv, table, text")
  }),
  health: z.object({
    check: z.enum(["all", "services", "processes", "disk", "network", "custom"]).describe("Health check type: all (services+processes+disk+network), services, processes, disk, network, or custom commands"),
    services: z.string().optional().describe("Comma-separated service names for services check (default: sidekick-mcp,sidekick-dashboard,sidekick-agent)"),
    commands: z.string().optional().describe("Comma-separated shell commands for custom check"),
    threshold: z.string().optional().describe("Alert thresholds (e.g. 'disk>90,mem>80')")
  }),
  delay: z.object({
    action: z.enum(["add", "list", "cancel", "run"]).describe("Delay action: add (schedule new), list (show all), cancel (remove pending), run (execute immediately)"),
    id: z.string().optional().describe("Delay ID (required for cancel/run)"),
    when: z.string().optional().describe("When to execute: 10s, 5m, 2h, 1d, or ISO date string"),
    name: z.string().optional().describe("Human-readable name for the delay"),
    tool: z.string().optional().describe("Tool name to execute (for add action)"),
    args: z.record(z.any()).optional().describe("Arguments to pass to the tool (for add action)")
  }),
  snapshot: z.object({
    action: z.enum(["capture", "compare", "list", "delete"]).describe("Snapshot action: capture (save state), compare (detect drift), list (show all), delete (remove)"),
    name: z.string().optional().describe("Snapshot name"),
    capture: z.string().optional().describe("What to capture: processes,services,disk,packages,network,files:/path (comma-separated)"),
    compare: z.string().optional().describe("Baseline snapshot name for compare action")
  }),
  watch: z.object({
    action: z.enum(["add", "list", "remove", "pause", "check"]).describe("Watch action: add (create new), list (show all), remove (delete), pause (pause/resume), check (manual check)"),
    id: z.string().optional().describe("Watch ID (required for remove/pause/check)"),
    name: z.string().optional().describe("Human-readable watch name"),
    source: z.string().optional().describe("Watch source: service, process, endpoint, or file"),
    target: z.string().optional().describe("Watch target: service name, process name, URL, or file path"),
    condition: z.string().optional().describe("Trigger condition: status!=active, not_running, status!=200, content_matches, exists, not_exists"),
    interval: z.string().optional().describe("Check interval: 30s, 5m, 1h (default: 60s)"),
    action_tool: z.string().optional().describe("Tool to call when triggered (default: notify)"),
    action_args: z.record(z.any()).optional().describe("Arguments for action tool"),
    pause: z.boolean().optional().describe("True to pause, false to resume")
  }),
  secret: z.object({
    action: z.enum(["store", "get", "delete", "list", "rotate"]).describe("Secret action: store (save encrypted), get (retrieve), delete (remove), list (show names), rotate (generate new)"),
    key: z.string().optional().describe("Secret name/key"),
    value: z.string().optional().describe("Secret value (for store action)"),
    generate: z.string().optional().describe("Length for rotation (e.g. '32' for 32-char random hex)")
  }),
  security_scan: z.object({
    path: z.string().optional().describe("Directory to scan (default Sidekick repository)"),
    max_files: z.number().int().min(1).max(10000).optional().describe("Maximum files to inspect (default 2000, maximum 10000)"),
    format: z.enum(["text", "json"]).optional().describe("Output format (default text)")
  }),
  hash: z.object({
    input: z.string().optional().describe("Data to hash (string content)"),
    path: z.string().optional().describe("File path to hash"),
    algorithm: z.string().optional().describe("Hash algorithm: md5, sha1, sha256, sha512 (default: sha256)"),
    verify: z.string().optional().describe("Expected hash value to verify against")
  }),
  queue: z.object({
    action: z.enum(["add", "list", "process", "remove", "clear"]).describe("Queue action"),
    id: z.number().optional().describe("Task ID (for remove action)"),
    tool: z.string().optional().describe("Tool name to queue (for add action)"),
    args: z.record(z.any()).optional().describe("Tool arguments (for add action)"),
    priority: z.number().optional().describe("Task priority, higher = more important (default: 0)"),
    status: z.string().optional().describe("Status filter for list/clear: pending, processing, completed, failed, or all")
  }),
  retry: z.object({
    tool: z.string().describe("Tool name to retry"),
    args: z.record(z.any()).optional().describe("Tool arguments"),
    max_attempts: z.number().optional().describe("Maximum retry attempts (default: 3)"),
    backoff: z.enum(["exponential", "linear", "fixed"]).optional().describe("Backoff strategy (default: exponential)"),
    initial_delay: z.number().optional().describe("Initial delay in milliseconds (default: 1000)")
  }),
  evolve: z.object({
    action: z.enum(["analyze", "candidates", "inspect", "propose", "validate", "test", "approve", "activate_trial", "promote", "reject", "revise", "deprecate", "feedback", "report", "list", "cleanup"]).describe("Evolve action"),
    id: z.string().optional().describe("Candidate or generated capability ID/name"),
    proposal: z.string().optional().describe("Deprecated legacy proposal text"),
    approver: z.string().optional().describe("Approver identity for approve/activate_trial"),
    useful: z.boolean().optional().describe("Feedback: true if useful, false if not"),
    notes: z.string().optional().describe("Feedback or lifecycle notes"),
    reason: z.string().optional().describe("Reject/deprecate reason"),
    limit: z.number().optional().describe("Number of logs to analyze"),
    approve: z.boolean().optional().describe("Deprecated - use action=approve"),
    test: z.boolean().optional().describe("Deprecated - use action=test"),
    confirm: z.coerce.boolean().optional().describe("For cleanup action - actually delete old entries")
  }),
  orchestrate: z.object({
    action: z.enum(["create", "execute", "list", "status", "cancel"]).describe("Orchestrate action"),
    id: z.number().optional().describe("Task ID (for execute/status/cancel)"),
    task_name: z.string().optional().describe("Task name (for create)"),
    subtasks: z.array(z.record(z.any())).optional().describe("Subtask definitions (for create)"),
    dependencies: z.record(z.array(z.string())).optional().describe("Dependency map (for create)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 1800000)")
  }),
  predict: z.object({
    action: z.enum(["analyze", "list", "get", "feedback", "outcome", "dismiss", "explain", "status", "suggest", "migrate", "purge_preview", "purge", "diagnose"]).describe("Predict action"),
    id: z.string().optional().describe("Prediction ID"),
    type: z.string().optional().describe("Filter by prediction type"),
    scope: z.enum(["project", "session", "task", "global"]).optional().describe("Analysis scope. Inferred from project/session_id/task_id when omitted; use 'global' to deliberately analyze every project"),
    confirm: z.boolean().optional().describe("Required (true) to execute a purge"),
    retention_days: z.number().optional().describe("Override the configured retention period for purge_preview/purge"),
    purge_legacy: z.boolean().optional().describe("Also purge legacy (pre-v2) terminal predictions, which are preserved by default"),
    project: z.string().optional().describe("Project scope"),
    session_id: z.string().optional().describe("Session ID"),
    task_id: z.string().optional().describe("Task ID"),
    feedback: z.string().optional().describe("Feedback value (useful|not_useful|incorrect|already_known|acted_on|dismissed)"),
    outcome: z.string().optional().describe("Outcome value (confirmed|did_not_occur|action_succeeded|action_failed|expired|superseded|unresolved)"),
    limit: z.number().optional().describe("Max results (default 20, max 100)"),
    status: z.string().optional().describe("Filter by status (active|expired|superseded|dismissed|confirmed|did_not_occur)"),
    confidence: z.string().optional().describe("Filter by confidence (none|low|medium|high|very_high)"),
    maxAge: z.string().optional().describe("Analysis window (default 7d)")
  }),
  debug_tool: z.object({
    action: z.enum(["store", "recall", "cleanup", "start", "stop", "cache", "get", "status", "clear"]).describe("Debug action"),
    session_name: z.string().optional().describe("Session identifier (for legacy session actions)"),
    key: z.string().optional().describe("Cache key (for get/cache) or debug key (for cleanup)"),
    value: z.string().optional().describe("Value to cache/store"),
    service: z.string().optional().describe("Service name (for store/recall)"),
    issue: z.string().optional().describe("Issue description (for store)"),
    redact: z.boolean().optional().describe("Default true - set false to skip redaction")
  }),
  fresheyes: z.object({
    problem: z.string().describe("Problem description"),
    context: z.string().optional().describe("Relevant context"),
    files: z.array(z.string()).optional().describe("Files analyzed"),
    hypotheses: z.array(z.string()).optional().describe("Current hypotheses"),
    full_response: z.boolean().optional().describe("Return full response vs key insights")
  }),
  batch: z.object({
    calls: z.array(z.object({
      tool: z.string().describe("Tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments for the tool")
    })).describe("Array of tool calls to execute (max 20)")
  }),
  cache: z.object({
    action: z.enum(["get", "set", "clear", "list"]).describe("Cache action"),
    key: z.string().optional().describe("Cache key"),
    ttl: z.string().optional().describe("Time-to-live: 30s, 5m, 1h (default: 5m)"),
    value: z.string().optional().describe("Value to cache (for set action)")
  }),
  summarize: z.object({
    path: z.string().describe("File path to summarize"),
    max_lines: z.number().optional().describe("Maximum lines to return (default: 50)"),
    strategy: z.enum(["head", "tail", "grep", "stats"]).optional().describe("Summarization strategy (default: head)"),
    pattern: z.string().optional().describe("Regex pattern for grep strategy")
  }),
  filter: z.object({
    path: z.string().describe("File or directory path to filter"),
    pattern: z.string().optional().describe("Regex pattern to match"),
    after: z.string().optional().describe("ISO date: include files modified after this date"),
    before: z.string().optional().describe("ISO date: include files modified before this date"),
    max_results: z.number().optional().describe("Maximum results to return (default: 50)")
  }),
  project: z.object({
    name: z.string().describe("Project name"),
    include: z.string().optional().describe("Sections to include: kv,context,logs,procedures (default: kv,context)")
  }),
  tail: z.object({
    source: z.string().describe("Source: log.jsonl, journalctl, or file path"),
    pattern: z.string().optional().describe("Regex filter (for journalctl: service name)"),
    lines: z.number().optional().describe("Number of lines to return (default: 50)"),
    since: z.string().optional().describe("Filter entries since this date (ISO or relative: 1h, 1d)")
  }),
  diff_files: z.object({
    path_a: z.string().describe("First file path"),
    path_b: z.string().describe("Second file path"),
    format: z.enum(["unified", "summary"]).optional().describe("Output format (default: unified)")
  }),
  find: z.object({
    path: z.string().describe("Directory to search in"),
    name: z.string().optional().describe("File name glob pattern (e.g. '*.js')"),
    modified_after: z.string().optional().describe("ISO date: files modified after"),
    modified_before: z.string().optional().describe("ISO date: files modified before"),
    size_min: z.string().optional().describe("Minimum file size (e.g. '1KB', '1MB')"),
    size_max: z.string().optional().describe("Maximum file size (e.g. '10MB')"),
    content: z.string().optional().describe("Regex pattern to match file contents"),
    max_results: z.number().optional().describe("Maximum results (default: 50)")
  }),
  status: z.object({
    include: z.string().optional().describe("Sections: services,disk,memory,load,uptime,processes (default: services,disk)"),
    services: z.string().optional().describe("Comma-separated service names (default: sidekick-mcp,sidekick-dashboard,sidekick-agent)")
  }),
  extract: z.object({
    path: z.string().describe("File path (JSON, YAML, INI, or XML)"),
    fields: z.union([z.string(), z.array(z.string())]).optional().describe("Field paths to extract (e.g. 'database.host,database.port')")
  }),
  anonymize: z.object({
    action: z.enum(["anonymize", "patterns", "add_pattern", "remove_pattern"]),
    input: z.string().optional().describe("Text to anonymize"),
    format: z.enum(["text", "json", "yaml"]).optional().default("text"),
    custom_patterns: z.array(z.object({
      pattern: z.string(),
      replacement: z.string()
    })).optional(),
    consistency: z.boolean().optional().default(true).describe("Same input always maps to same output")
  }),
  sandbox: z.object({
    action: z.enum(["exec", "rollback", "list", "diff", "clean"]),
    sandbox_name: z.string().optional(),
    command: z.string().optional().describe("Command to execute in sandbox"),
    files: z.array(z.string()).optional().describe("Files to auto-backup before exec"),
    auto_backup: z.boolean().optional().default(true),
    rollback_id: z.string().optional()
  }),
  changelog: z.object({
    action: z.enum(["generate", "preview", "save"]),
    from: z.string().describe("Starting ref (tag, commit, branch)"),
    to: z.string().optional().default("HEAD"),
    format: z.enum(["markdown", "plain", "conventional"]).optional().default("markdown"),
    group_by: z.enum(["type", "scope", "author"]).optional().default("type"),
    use_llm: z.boolean().optional().default(false),
    include: z.enum(["all", "features", "fixes", "breaking", "refactor", "deps"]).optional().default("all"),
    path: z.string().optional().describe("Git repository path (default: current directory)")
  }),
  netdiag: z.object({
    action: z.enum(["check", "dns", "route", "ports", "listeners", "connectivity"]),
    target: z.string().describe("Host, URL, or IP to diagnose"),
    port_range: z.string().optional().describe("Port range for scan (e.g., '80-443')"),
    timeout: z.number().optional().default(5000),
    format: z.enum(["detailed", "compact", "json"]).optional().default("detailed")
  }),
  timeline: z.object({
    action: z.enum(["build", "filter", "export"]),
    since: z.string().describe("Start time (ISO or relative: 1h, 1d, 7d)"),
    until: z.string().optional().default("now"),
    sources: z.array(z.enum(["log.jsonl", "journalctl", "git", "files", "all"])).optional().default(["all"]),
    pattern: z.string().optional().describe("Regex filter for event content"),
    severity: z.enum(["error", "warn", "info", "all"]).optional().default("all"),
    format: z.enum(["compact", "detailed", "json"]).optional().default("compact"),
    max_events: z.number().optional().default(200)
  }),
  circuit: z.object({
    action: z.enum(["call", "status", "reset", "configure"]),
    target: z.string().describe("Circuit target label (e.g., 'github-api', 'web-fetch')"),
    tool: z.string().optional().describe("Tool name to call (for action=call)"),
    args: z.record(z.any()).optional().describe("Tool arguments (for action=call)"),
    failure_threshold: z.number().optional().default(5),
    cooldown_seconds: z.number().optional().default(60),
    cache_response: z.boolean().optional().default(false)
  }),
  baseline: z.object({
    action: z.enum(["record", "learn", "check", "status", "reset"]),
    metric_name: z.string().describe("Metric identifier"),
    value: z.number().optional().describe("Value to record (for action=record)"),
    source: z.string().optional().describe("Data source: 'health', 'custom', 'command'"),
    command: z.string().optional().describe("Command to collect metric (for source=command)"),
    window: z.string().optional().default("7d").describe("History window to analyze"),
    sensitivity: z.enum(["low", "medium", "high"]).optional().default("medium")
  }),
  depend: z.object({
    action: z.enum(["tree", "reverse", "outdated", "impact", "orphans"]),
    type: z.enum(["npm", "service", "process"]),
    target: z.string().optional().describe("Package, service, or PID to analyze"),
    depth: z.number().optional().default(5),
    format: z.enum(["tree", "flat", "json"]).optional().default("tree")
  }),
  runbook: z.object({
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
  ops: z.object({
    action: z.enum(["verify_deployed_commit", "restart_and_smoke_test", "deploy_current_main", "incident_snapshot"]).describe("Packaged operations workflow to run"),
    repo_path: z.string().optional().describe("Repository path. Defaults to the current Sidekick repo."),
    restart_mcp: z.boolean().optional().default(false).describe("For restart_and_smoke_test, schedule sidekick-mcp restart after the response.")
  }),
  mission: z.object({
    action: z.enum(["profiles", "route", "preflight", "execute"]).optional().default("route").describe("Mission Control action"),
    intent: z.string().optional().describe("User goal or operation intent"),
    profile: z.enum(["read_only_audit", "trusted_vps", "production", "danger_zone"]).optional().default("trusted_vps").describe("Run profile"),
    confirm: z.boolean().optional().describe("Required true for mutating execute routes"),
    key: z.string().optional().describe("KV key for delete missions"),
    project: z.string().optional().describe("Project name for memory missions"),
    query: z.string().optional().describe("Search query for tool discovery"),
    include: z.string().optional().describe("Include sections for status/project"),
    services: z.string().optional().describe("Services for status missions"),
    repo_path: z.string().optional().describe("Repository path for deploy workflows"),
    limit: z.number().optional().describe("Result limit"),
    tool: z.string().optional().describe("Tool filter for logs"),
    source: z.string().optional().describe("Source filter for logs"),
    format: z.string().optional().describe("Output format for tool discovery")
  }),
  black_box: z.object({
    action: z.enum([
      "capture", "capture_status", "cancel_capture", "list", "get", "delete", "analyze",
      "list_incidents", "get_incident", "list_captures", "get_capture", "list_sources", "get_source",
      "search", "compare", "add_note", "update_incident", "verify", "pin", "extend_retention",
      "archive", "export", "storage_status", "purge_preview", "purge", "profiles"
    ]),
    name: z.string().optional().describe("Incident name/title"),
    title: z.string().optional().describe("Incident title"),
    description: z.string().optional().describe("Incident description"),
    project: z.string().optional(),
    environment: z.string().optional(),
    severity: z.string().optional(),
    lifecycle_state: z.string().optional(),
    tags: z.array(z.string()).optional(),
    profile: z.enum(["quick", "standard", "deep", "network", "service", "sidekick", "repository", "custom"]).optional(),
    include: z.array(z.string()).optional().describe("Legacy sections or collector keys"),
    analyze_with_llm: z.boolean().optional().default(false),
    use_llm: z.boolean().optional().default(true),
    incident_id: z.string().optional(),
    capture_id: z.string().optional(),
    compare_capture_id: z.string().optional(),
    source_id: z.string().optional(),
    query: z.string().optional(),
    note: z.string().optional(),
    content: z.string().optional(),
    note_type: z.string().optional(),
    retention_class: z.string().optional(),
    reason: z.string().optional(),
    format: z.enum(["json", "markdown"]).optional(),
    raw: z.boolean().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
    confirm: z.boolean().optional().default(false)
  }),
  db_schema: z.object({
    table: z.string().optional().describe("Specific table name (optional)"),
    verbose: z.boolean().optional().describe("Include row counts and detailed info"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  db_query: z.object({
    sql: z.string().describe("SQL query to execute"),
    params: z.array(z.any()).optional().describe("Query parameters"),
    readonly: z.boolean().optional().default(true).describe("Read-only mode (blocks writes)"),
    limit: z.number().optional().default(1000).describe("Maximum rows to return"),
    timeout: z.number().optional().default(5000).describe("Query timeout in milliseconds"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  db_stats: z.object({
    detailed: z.boolean().optional().describe("Include per-table statistics"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  db_backup: z.object({
    path: z.string().optional().describe("Output path (default: data/backups/)"),
    compress: z.boolean().optional().default(true).describe("Gzip compression")
  }),
  db_restore: z.object({
    path: z.string().describe("Backup file path"),
    verify: z.boolean().optional().default(true).describe("Check integrity before restore")
  }),
  log_query: z.object({
    tool: z.string().optional().describe("Filter by tool name"),
    source: z.string().optional().describe("Filter by source: mcp/agent/dashboard"),
    success: z.boolean().optional().describe("Filter by success status"),
    since: z.string().optional().describe("Start time (ISO or relative: 1h, 1d)"),
    until: z.string().optional().describe("End time (ISO timestamp)"),
    limit: z.number().optional().default(100).describe("Maximum results")
  }),
  db_export: z.object({
    table: z.string().optional().describe("Specific table (exports all if omitted)"),
    format: z.enum(["json", "csv", "sql"]).optional().default("json").describe("Export format"),
    path: z.string().optional().describe("Output file path"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  db_search: z.object({
    query: z.string().describe("Search terms"),
    tables: z.string().optional().describe("Comma-separated table names"),
    limit: z.number().optional().default(50).describe("Maximum results"),
    database: z.enum(["sqlite", "postgres"]).optional().default("sqlite").describe("Database backend")
  }),
  db_migrate: z.object({
    action: z.enum(["status", "list", "up"]).describe("Migration action"),
    version: z.number().optional().describe("Target version"),
    name: z.string().optional().describe("Migration filename (for up action)")
  }),
  db_diff: z.object({
    snapshot_a: z.string().optional().describe("Path to snapshot A or 'current'"),
    snapshot_b: z.string().optional().describe("Path to snapshot B or 'current'"),
    table: z.string().optional().describe("Specific table to compare")
  }),
  redis: z.object({
    action: z.enum(["get", "set", "del", "keys", "ttl", "info", "flush"]).describe("Redis action"),
    key: z.string().optional().describe("Redis key"),
    value: z.string().optional().describe("Value for set action"),
    ttl: z.string().optional().describe("TTL in seconds for set action"),
    pattern: z.string().optional().describe("Pattern for keys action (default '*')")
  }),
  ocr: z.object({
    path: z.string().describe("Image file path"),
    language: z.string().optional().default("eng").describe("OCR language (default: eng)"),
    psm: z.number().optional().describe("Page segmentation mode")
  }),
  media: z.object({
    action: z.enum(["info", "convert", "extract_audio", "thumbnail", "resize", "trim"]).describe("Media action"),
    input: z.string().describe("Input file path"),
    output: z.string().optional().describe("Output file path"),
    options: z.string().optional().describe("Format-specific options")
  }),
  transcribe: z.object({
    path: z.string().describe("Audio/video file path"),
    model: z.string().optional().default("base").describe("Whisper model (tiny|base|small|medium)"),
    language: z.string().optional().describe("Language code")
  }),
  analytics: z.object({
    query: z.string().optional().describe("SQL query"),
    file: z.string().optional().describe("Data file path (CSV, JSON, or Parquet)"),
    format: z.string().optional().describe("File format (csv|json|parquet)")
  }),
  insight_report: z.object({
    paths: z.union([z.string(), z.array(z.string())]).describe("Text, data, or image file path(s) to analyze"),
    title: z.string().optional().describe("Optional report title")
  }),
  embed: z.object({
    text: z.string().describe("Text to embed"),
    model: z.string().optional().default("nomic-embed-text").describe("Embedding model")
  }),
  ollama: z.object({
    action: z.enum(["list", "ps", "pull", "show"]).describe("Ollama action"),
    model: z.string().optional().describe("Model name (required for pull/show)")
  }),
  tunnel: z.object({
    action: z.enum(["start", "stop", "list"]).describe("Tunnel action"),
    port: z.number().optional().describe("Local port to expose (required for start)"),
    name: z.string().optional().describe("Tunnel name (optional)")
  }),
  download: z.object({
    url: z.string().describe("Video URL"),
    output: z.string().optional().describe("Output path"),
    format: z.string().optional().describe("Video format"),
    audio_only: z.boolean().optional().describe("Extract audio only")
  }),
  wireguard: z.object({
    action: z.enum(["status", "list_peers", "add_peer", "remove_peer", "generate_keypair"]).describe("WireGuard action"),
    interface_name: z.string().optional().describe("WireGuard interface (e.g. wg0)"),
    peer_name: z.string().optional().describe("Peer name (for add_peer)"),
    public_key: z.string().optional().describe("Peer public key"),
    endpoint: z.string().optional().describe("Peer endpoint IP:port"),
    allowed_ips: z.string().optional().describe("Allowed IPs (default 10.0.0.0/24)")
  }),
  nginx: z.object({
    action: z.enum(["status", "list_sites", "add_site", "remove_site", "test_config", "reload"]).describe("Nginx action"),
    site_name: z.string().optional().describe("Site config name"),
    domain: z.string().optional().describe("Domain name (for add_site)"),
    upstream_port: z.number().optional().describe("Local port to proxy to"),
    ssl_email: z.string().optional().describe("Email for Let's Encrypt")
  }),
  knowledge: z.object({
    action: z.enum(["search", "get", "list", "add", "update", "delete", "purge"]).describe("Knowledge base action"),
    id: z.number().optional().describe("Entry ID (for get/update/delete)"),
    category: z.string().optional().describe("Category (for list/add/update)"),
    title: z.string().optional().describe("Title (for add/update)"),
    content: z.string().optional().describe("Content (for add/update)"),
    tags: z.string().optional().describe("Comma-separated tags (for add/update)"),
    query: z.string().optional().describe("Search query (for search)"),
    limit: z.number().optional().describe("Max results (for search/list)")
  }),
  metrics: z.object({
    action: z.enum(["write", "query", "list_measurements", "list_fields"]).describe("Metrics action"),
    measurement: z.string().optional().describe("Measurement name (for write/list_fields)"),
    fields: z.record(z.any()).optional().describe("Field values (for write)"),
    tags: z.record(z.string()).optional().describe("Tags (for write)"),
    timestamp: z.number().optional().describe("Nanosecond timestamp (for write)"),
    query: z.string().optional().describe("Flux query (for query action)"),
    time_range: z.string().optional().describe("Time range for list_fields (e.g. -30d)")
  }),
  compute: z.object({
    action: z.enum(["overview", "init"]).describe("Compute action")
  }),
  compute_nodes: z.object({
    action: z.enum(["list", "get", "heartbeat", "revoke", "maintenance", "stats", "create_token", "list_tokens", "enroll"]).describe("Worker node action"),
    node_id: z.string().optional().describe("Worker node ID"),
    token: z.string().optional().describe("Enrollment token"),
    display_name: z.string().optional().describe("Worker or token display name"),
    platform: z.string().optional().describe("Worker platform"),
    architecture: z.string().optional().describe("Worker architecture"),
    cpu_info: z.string().optional().describe("Worker CPU info"),
    memory_bytes: z.number().optional().describe("Worker memory in bytes"),
    accelerators: z.array(z.any()).optional().describe("Worker accelerator descriptors"),
    providers: z.array(z.any()).optional().describe("Worker provider descriptors"),
    executors: z.array(z.any()).optional().describe("Worker executor descriptors"),
    worker_version: z.string().optional().describe("Worker agent version"),
    public_key: z.string().optional().describe("Worker public key"),
    trust_level: z.string().optional().describe("Worker trust level"),
    allowed_data_classifications: z.array(z.string()).optional().describe("Allowed data classifications for token"),
    max_concurrent_jobs: z.number().optional().describe("Maximum concurrent jobs for enrolled worker"),
    expires_in_ms: z.number().optional().describe("Enrollment token lifetime in milliseconds"),
    created_by: z.string().optional().describe("Enrollment token creator"),
    reason: z.string().optional().describe("Revoke reason"),
    enable: z.boolean().optional().describe("Enable/disable maintenance"),
    state: z.string().optional().describe("Filter by worker state for list"),
    hardware_type: z.string().optional().describe("Filter by hardware_type for list"),
    provider: z.string().optional().describe("Filter by provider for list")
  }),
  compute_providers: z.object({
    action: z.enum(["list", "get", "create", "update", "delete", "health", "health_all"]).describe("Provider action"),
    provider_id: z.string().optional().describe("Provider ID"),
    name: z.string().optional().describe("Provider display name (required for create)"),
    type: z.string().optional().describe("Provider type (ollama|openai|vllm|llamacpp|mlx|mock) — required for create, filters list"),
    base_url: z.string().optional().describe("Provider endpoint. http/https only; loopback and private/RFC1918 addresses are allowed, link-local and cloud metadata endpoints are not"),
    api_key: z.string().optional().describe("Recorded on the provider row but NOT currently used to authenticate: no adapter reads it. Do not paste a live credential here"),
    priority: z.number().optional().describe("Placement priority; HIGHER wins (scores are summed and sorted descending). Default 50"),
    enabled: z.boolean().optional().describe("Enable/disable provider"),
    trust_level: z.string().optional().describe("Placement gate (untrusted|limited|trusted|privileged). UPDATE ONLY — rejected on create, which always starts a provider at 'untrusted'. Promoting is a deliberate second step"),
    capabilities: z.array(z.string()).optional().describe("Descriptive only — placement gates on MODEL capabilities, not provider capabilities"),
    mode: z.string().optional().describe("Provider mode (direct|worker). Default direct"),
    tls_policy: z.string().optional().describe("TLS policy (require|prefer|off). Default prefer"),
    cost_policy: z.string().optional().describe("Cost policy, e.g. free. Default free"),
    data_classifications: z.array(z.string()).optional().describe("Placement gate (public|internal|private|sensitive|restricted): which classifications may be routed here. UPDATE ONLY — rejected on create, which always starts a provider at ['public']")
  }),
  compute_models: z.object({
    action: z.enum(["list", "get", "create", "update", "delete", "discover"]).describe("Model action"),
    model_id: z.string().optional().describe("Model ID"),
    provider_id: z.string().optional().describe("Provider ID — required for create, filters list"),
    model_name: z.string().optional().describe("Model display name (required for create)"),
    provider_model_name: z.string().optional().describe("Model name as the provider knows it, e.g. qwen3.5:latest (required for create)"),
    family: z.string().optional().describe("Model family (stored as metadata)"),
    parameter_count: z.string().optional().describe("Parameter count, e.g. 7b, 13b (stored as metadata)"),
    context_length: z.number().optional().describe("Context window size"),
    supports_vision: z.boolean().optional().describe("Supports vision"),
    supports_tools: z.boolean().optional().describe("Supports tool calling"),
    supports_embedding: z.boolean().optional().describe("Supports embedding"),
    supports_structured_output: z.boolean().optional().describe("Supports structured output"),
    min_vram_gb: z.number().positive().max(4096).optional().describe("Minimum VRAM in GB (stored as estimated memory bytes)"),
    capabilities: z.array(z.string()).optional().describe("Capabilities this model serves, e.g. chat, generate, embeddings. Placement gates on these: a model advertising none cannot be selected"),
    capability: z.string().optional().describe("Filter list by a single capability"),
    preferred_workloads: z.array(z.string()).optional().describe("Workloads this model is preferred for"),
    quantization: z.string().optional().describe("Quantization, e.g. Q4_K_M"),
    enabled: z.boolean().optional().describe("Enable/disable model")
  }),
  compute_jobs: z.object({
    action: z.enum(["list", "get", "create", "cancel", "stats", "artifacts"]).describe("Job action"),
    job_id: z.string().optional().describe("Job ID (get, cancel, artifacts)"),
    // list filters
    status: z.string().optional().describe("Filter by status (list)"),
    limit: z.number().int().positive().max(500).optional().describe("Max results (list, default 50)"),
    provider_id: z.string().optional().describe("Filter by provider ID (list)"),
    worker_id: z.string().optional().describe("Filter by worker ID (list)"),
    // create: routing and classification
    job_type: z.string().optional().describe("Canonical job type (create; also a list filter): chat|generate|embeddings|text_embedding"),
    capability: z.string().max(128).optional().describe("Requested capability, preserved exactly (create; also a list filter), e.g. openvino.text_embedding"),
    data_classification: z.enum(["public", "internal", "private"]).optional().describe("Data classification (create); preserved when supplied, defaults to private"),
    project: z.string().max(200).optional().describe("Project label (create metadata; also a list filter)"),
    // create: structured executor contract
    request_payload: z.record(z.any()).optional().describe("Structured executor request payload (create); validated by the job contract and executor-specific rules. Do not combine with prompt/model/provider."),
    capability_requirements: z.record(z.any()).optional().describe("Capability requirements (create), e.g. { executor, model }"),
    // create: convenience payload, mapped into request_payload when request_payload is absent
    prompt: z.string().optional().describe("Prompt (create convenience; mapped to request_payload.prompt)"),
    model: z.string().optional().describe("Model name (create convenience; mapped to request_payload.model)"),
    provider: z.string().optional().describe("Preferred provider hint (create convenience; mapped to request_payload.provider)"),
    // create: limits
    timeout_ms: z.number().int().min(1000).max(86400000).optional().describe("Job timeout in ms (create), 1000..86400000"),
    max_retries: z.number().int().min(0).max(10).optional().describe("Max retries after the first attempt (create); maps to maxAttempts = max_retries + 1"),
    idempotency_key: z.string().max(200).optional().describe("Idempotency key (create)"),
    // cancel
    reason: z.string().max(500).optional().describe("Cancellation reason (cancel)")
  }).strict(),
  compute_route: z.object({
    action: z.enum(["explain", "list_rules", "create_rule", "delete_rule"]).describe("Routing action"),
    workload_class: z.string().optional().describe("Workload class for explain (chat|generate|embeddings)"),
    capabilities_required: z.string().optional().describe("Comma-separated capabilities for explain"),
    data_classification: z.string().optional().describe("Data classification for explain (public|internal|private)"),
    trust_level: z.string().optional().describe("Trust level for explain"),
    rule_id: z.string().optional().describe("Routing rule ID"),
    rule_name: z.string().optional().describe("Rule name for create_rule"),
    priority: z.number().optional().describe("Rule priority"),
    description: z.string().optional().describe("Rule description"),
    preferred_providers: z.array(z.string()).optional().describe("Preferred provider IDs"),
    preferred_models: z.array(z.string()).optional().describe("Preferred model IDs"),
    fallback_providers: z.array(z.string()).optional().describe("Fallback provider IDs"),
    max_latency_ms: z.number().optional().describe("Max latency requirement")
  }),
};

function getToolSchema(name) {
  return TOOL_SCHEMAS[name];
}

module.exports = { TOOL_SCHEMAS, getToolSchema };
