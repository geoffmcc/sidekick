const { z } = require("zod");

const TOOL_SCHEMAS = {
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
  delay: z.object({
    action: z.enum(["add", "list", "cancel", "run"]).describe("Delay action: add (schedule new), list (show all), cancel (remove pending), run (execute immediately)"),
    id: z.string().optional().describe("Delay ID (required for cancel/run)"),
    when: z.string().optional().describe("When to execute: 10s, 5m, 2h, 1d, or ISO date string"),
    name: z.string().optional().describe("Human-readable name for the delay"),
    tool: z.string().optional().describe("Tool name to execute (for add action)"),
    args: z.record(z.any()).optional().describe("Arguments to pass to the tool (for add action)")
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
  batch: z.object({
    calls: z.array(z.object({
      tool: z.string().describe("Tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments for the tool")
    })).describe("Array of tool calls to execute (max 20)")
  }),
  project: z.object({
    name: z.string().describe("Project name"),
    include: z.string().optional().describe("Sections to include: kv,context,logs,procedures (default: kv,context)")
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
