const { z } = require("zod");

const TOOL_SCHEMAS = {
  compute: z.object({
    action: z.enum(["overview", "init"]).describe("Compute action")
  }),
  compute_nodes: z.object({
    action: z.enum(["list", "get", "heartbeat", "revoke", "maintenance", "stats", "create_token", "list_tokens", "enroll"]).describe("Worker node action"),
    node_id: z.string().optional().describe("Worker node ID"),
    worker_id: z.string().optional().describe("Worker ID for dashboard lifecycle actions"),
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
    re_enrollment_of: z.string().optional().describe("Node ID being re-enrolled"),
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
    action: z.enum(["list", "get", "create", "cancel", "retry", "recover", "stats", "artifacts", "reconcile_artifact_custody"]).describe("Job action"),
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
    reason: z.string().max(500).optional().describe("Cancellation reason (cancel)"),
    // reconcile_artifact_custody: dry run unless explicitly confirmed
    confirm: z.boolean().optional().describe("Execute the reconciliation (reconcile_artifact_custody); omitted or false performs a dry run that writes nothing")
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
