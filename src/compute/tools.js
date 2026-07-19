const compute = require("./index");
const { TRUST_LEVELS, DATA_CLASSIFICATIONS } = require("./errors");
const { validateEndpoint } = require("./endpoint-guard");

// Creating a provider grants CONNECTIVITY. It does not grant authority to
// receive sensitive data — that is a separate, explicit promotion via update.
//
// The registry's own defaults predate the trust taxonomy: trustLevel "private"
// ranks EQUAL to "trusted" in placement's TRUST_ORDER, and dataClassifications
// defaults to public/internal/private. A provider created with no trust field
// named would therefore be immediately eligible for private traffic, and since
// priority is caller-settable it could outrank the real providers. New rows
// created through the tool start at the bottom instead.
const CREATE_TRUST_FLOOR = Object.freeze({
  trustLevel: "untrusted",
  dataClassifications: ["public"],
});

// Fields that confer authority rather than connectivity. Rejected on create so
// that promotion is always a deliberate second step against a known provider_id.
const PROMOTION_FIELDS = ["trust_level", "data_classifications"];

function ok(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function err(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// The tool surface is snake_case, matching every other Sidekick tool; the
// registries take camelCase. Nothing bridged the two, and because the dispatcher
// strips any key not in the Zod schema, an unmapped name never reached the
// registry at all: `create` fell over on a NOT NULL column, and `update` matched
// no field, updated nothing, and returned the unchanged row as success. Every
// registry row to date had to be inserted with direct SQL because of this.
//
// Keys are mapped explicitly rather than by generic snake→camel conversion,
// because several names genuinely differ (name → displayName, base_url →
// endpoint) and a silent mismatch is exactly the failure being fixed here.
const PROVIDER_FIELD_MAP = {
  name: "displayName",
  type: "providerType",
  base_url: "endpoint",
  api_key: "authSecretKey",
  trust_level: "trustLevel",
  tls_policy: "tlsPolicy",
  cost_policy: "costPolicy",
  data_classifications: "dataClassifications",
  capabilities: "capabilities",
  priority: "priority",
  enabled: "enabled",
  mode: "mode",
  metadata: "metadata",
};

const MODEL_FIELD_MAP = {
  provider_id: "providerId",
  model_name: "displayName",
  provider_model_name: "providerModelName",
  capabilities: "capabilities",
  context_length: "contextLimit",
  supports_tools: "supportsTools",
  supports_vision: "supportsVision",
  supports_embedding: "supportsEmbedding",
  supports_structured_output: "supportsStructuredOutput",
  preferred_workloads: "preferredWorkloads",
  quantization: "quantization",
  enabled: "enabled",
};

const BYTES_PER_GB = 1024 ** 3;

function mapFields(args, fieldMap) {
  const mapped = {};
  for (const [from, to] of Object.entries(fieldMap)) {
    if (args[from] !== undefined) mapped[to] = args[from];
  }
  return mapped;
}

// family and parameter_count have no column of their own; they are descriptive
// and belong with the rest of the free-form model metadata.
//
// `existingMetadata` must be supplied on update: the registry replaces the
// whole metadata column, so building the object from the supplied fields alone
// would silently drop any key the caller did not happen to repeat.
function mapModelFields(args, existingMetadata) {
  const mapped = mapFields(args, MODEL_FIELD_MAP);
  if (args.min_vram_gb !== undefined) {
    if (!Number.isFinite(args.min_vram_gb)) throw new Error("min_vram_gb must be a finite number");
    mapped.estimatedMemoryBytes = Math.round(args.min_vram_gb * BYTES_PER_GB);
  }
  const delta = {};
  if (args.family !== undefined) delta.family = args.family;
  if (args.parameter_count !== undefined) delta.parameterCount = args.parameter_count;
  if (Object.keys(delta).length) mapped.metadata = { ...(existingMetadata || {}), ...delta };
  return mapped;
}

// Report a missing required field by its tool-facing name, not the SQLite
// column that would otherwise surface as a NOT NULL constraint error.
function missingFields(args, required) {
  return required.filter(f => args[f] === undefined || args[f] === null || args[f] === "");
}

// trust_level and data_classifications are placement gates, not labels:
// evaluateProviderCandidate compares a request's required trust and
// classification against whatever these say. An unrecognised value must be
// rejected outright rather than stored, because trustRank() maps anything it
// does not know to 0 — a typo would silently turn into "untrusted" and the
// operator would have no signal that the provider is now unselectable.
function invalidEnumValue(args) {
  if (args.trust_level !== undefined && !TRUST_LEVELS.includes(args.trust_level)) {
    return `Invalid trust_level "${args.trust_level}". Valid: ${TRUST_LEVELS.join(", ")}`;
  }
  if (args.data_classifications !== undefined) {
    const bad = args.data_classifications.filter(c => !DATA_CLASSIFICATIONS.includes(c));
    if (bad.length) return `Invalid data_classifications: ${bad.join(", ")}. Valid: ${DATA_CLASSIFICATIONS.join(", ")}`;
  }
  return null;
}

async function sidekick_compute({ action, ...args }) {
  try {
    compute.initialize();
    switch (action) {
      case "overview": return ok(compute.overview());
      case "init": compute.initialize(); return ok({ initialized: true });
      default: return err("Unknown compute action: " + action + ". Valid: overview, init");
    }
  } catch (e) { return err("compute error: " + e.message); }
}

async function sidekick_compute_nodes({ action, node_id, ...args }) {
  try {
    compute.initialize();
    switch (action) {
      case "list": return ok(compute.workerManager.listWorkers(args));
      case "get": {
        if (!node_id) return err("node_id required");
        const w = compute.workerManager.getWorkerByNodeId(node_id);
        return w ? ok(w) : err("Worker not found");
      }
      case "heartbeat": {
        if (!node_id) return err("node_id required");
        const w = compute.workerManager.getWorkerByNodeId(node_id);
        if (!w) return err("Worker not found or revoked");
        const updated = compute.workerManager.heartbeat(w.workerId, args);
        return ok(updated);
      }
      case "revoke": {
        if (!node_id) return err("node_id required");
        const w = compute.workerManager.getWorkerByNodeId(node_id);
        if (!w) return err("Worker not found");
        const revoked = compute.workerManager.revokeWorker(w.workerId, args.reason || "admin_revoked");
        return ok(revoked);
      }
      case "maintenance": {
        if (!node_id) return err("node_id required");
        const w = compute.workerManager.getWorkerByNodeId(node_id);
        if (!w) return err("Worker not found");
        const updated = compute.workerManager.updateWorker(w.workerId, { maintenanceMode: args.enable !== false });
        return ok(updated);
      }
      case "stats": return ok(compute.workerManager.getWorkerStats());
      case "create_token": {
        const result = compute.workerManager.createEnrollmentToken({
          displayName: args.display_name,
          trustLevel: args.trust_level || "trusted",
          allowedDataClassifications: args.allowed_data_classifications || ["public", "internal", "private"],
          maxConcurrentJobs: args.max_concurrent_jobs || 2,
          expiresInMs: args.expires_in_ms || 3600000,
          createdBy: args.created_by || "admin",
          reEnrollmentOf: args.re_enrollment_of || null,
        });
        return ok({ ...result, message: "Token created. Give the token value to the worker operator. It will not be shown again." });
      }
      case "list_tokens": {
        const dbStore = require("../db");
        const db = dbStore.getDb();
        const rows = db.prepare("SELECT token_id, display_name, trust_level, max_concurrent_jobs, expires_at, consumed_at, consumed_by_worker, created_by, created_at FROM compute_enrollment_tokens ORDER BY created_at DESC").all();
        return ok(rows.map(r => ({
          tokenId: r.token_id,
          displayName: r.display_name,
          trustLevel: r.trust_level,
          maxConcurrentJobs: r.max_concurrent_jobs,
          expiresAt: r.expires_at,
          consumedAt: r.consumed_at,
          consumedByWorker: r.consumed_by_worker,
          createdBy: r.created_by,
          createdAt: r.created_at,
          status: r.consumed_at ? "consumed" : (new Date(r.expires_at) < new Date() ? "expired" : "active"),
        })));
      }
      case "enroll": {
        if (!args.token || !node_id || !args.display_name || !args.platform) {
          return err("token, node_id, display_name, and platform required");
        }
        const enrolled = compute.workerManager.enrollWorker({
          nodeId: node_id,
          displayName: args.display_name,
          platform: args.platform,
          architecture: args.architecture,
          cpuInfo: args.cpu_info,
          memoryBytes: args.memory_bytes,
          accelerators: args.accelerators,
          providers: args.providers,
          executors: args.executors,
          workerVersion: args.worker_version,
          publicKey: args.public_key,
          enrollmentToken: args.token,
        });
        return ok({ ...enrolled.worker, credential: enrolled.credential, credentialType: "worker-bearer-v1" });
      }
      default: return err("Unknown action: " + action + ". Valid: list, get, heartbeat, revoke, maintenance, stats, create_token, list_tokens, enroll");
    }
  } catch (e) { return err("compute_nodes error: " + e.message); }
}

async function sidekick_compute_providers({ action, provider_id, ...args }) {
  try {
    compute.initialize();
    switch (action) {
      // Filters need mapping too: an unmapped filter bound nothing and the
      // caller silently got the whole unfiltered list back.
      case "list": return ok(compute.providerRegistry.listProviders(mapFields(args, PROVIDER_FIELD_MAP)));
      case "get": {
        if (!provider_id) return err("provider_id required");
        const p = compute.providerRegistry.getProvider(provider_id);
        return p ? ok(p) : err("Provider not found");
      }
      case "create": {
        const missing = missingFields(args, ["type", "name"]);
        if (missing.length) return err(`Missing required field(s) for create: ${missing.join(", ")}`);
        const promoting = PROMOTION_FIELDS.filter(f => args[f] !== undefined);
        if (promoting.length) {
          return err(
            `${promoting.join(" and ")} cannot be set during create. Creating a provider grants connectivity only; ` +
            "authority to handle sensitive data is a separate step. Create the provider, verify it with " +
            "action=health, then promote it with action=update."
          );
        }
        const endpointError = args.base_url !== undefined ? validateEndpoint(args.base_url) : null;
        if (endpointError) return err(endpointError);
        const p = compute.providerRegistry.createProvider({
          ...CREATE_TRUST_FLOOR,
          ...mapFields(args, PROVIDER_FIELD_MAP),
        });
        return ok(p);
      }
      case "update": {
        if (!provider_id) return err("provider_id required");
        const invalid = invalidEnumValue(args);
        if (invalid) return err(invalid);
        const endpointError = args.base_url !== undefined ? validateEndpoint(args.base_url) : null;
        if (endpointError) return err(endpointError);
        const updates = mapFields(args, PROVIDER_FIELD_MAP);
        // Without this an unrecognised field set silently updated nothing and
        // still reported success.
        if (Object.keys(updates).length === 0) return err("No updatable fields supplied");
        const p = compute.providerRegistry.updateProvider(provider_id, updates);
        return p ? ok(p) : err("Provider not found");
      }
      case "delete": {
        if (!provider_id) return err("provider_id required");
        const deleted = compute.providerRegistry.deleteProvider(provider_id);
        return deleted ? ok({ deleted: true }) : err("Provider not found");
      }
      case "health": {
        if (!provider_id) return err("provider_id required");
        const result = await compute.healthMonitor.checkNow(provider_id);
        return ok(result);
      }
      case "health_all": return ok(compute.healthMonitor.getStatus());
      default: return err("Unknown action: " + action + ". Valid: list, get, create, update, delete, health, health_all");
    }
  } catch (e) { return err("compute_providers error: " + e.message); }
}

async function sidekick_compute_models({ action, model_id, ...args }) {
  try {
    compute.initialize();
    switch (action) {
      case "list": return ok(compute.modelRegistry.listModels({
        ...mapFields(args, MODEL_FIELD_MAP),
        ...(args.capability !== undefined ? { capability: args.capability } : {}),
      }));
      case "get": {
        if (!model_id) return err("model_id required");
        const m = compute.modelRegistry.getModel(model_id);
        return m ? ok(m) : err("Model not found");
      }
      case "create": {
        const missing = missingFields(args, ["provider_id", "model_name", "provider_model_name"]);
        if (missing.length) return err(`Missing required field(s) for create: ${missing.join(", ")}`);
        const m = compute.modelRegistry.createModel(mapModelFields(args));
        return ok(m);
      }
      case "update": {
        if (!model_id) return err("model_id required");
        const existing = compute.modelRegistry.getModel(model_id);
        if (!existing) return err("Model not found");
        const updates = mapModelFields(args, existing.metadata);
        if (Object.keys(updates).length === 0) return err("No updatable fields supplied");
        const m = compute.modelRegistry.updateModel(model_id, updates);
        return m ? ok(m) : err("Model not found");
      }
      case "delete": {
        if (!model_id) return err("model_id required");
        const deleted = compute.modelRegistry.deleteModel(model_id);
        return deleted ? ok({ deleted: true }) : err("Model not found");
      }
      case "discover": {
        const results = await compute.inferenceService.listModels(args);
        return ok(results);
      }
      default: return err("Unknown action: " + action + ". Valid: list, get, create, update, delete, discover");
    }
  } catch (e) { return err("compute_models error: " + e.message); }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Executor-specific validation of a nested request_payload. The generic job
// contract (validateJobContract) enforces supported executors, forbidden
// process fields, JSON bounds, and size limits; this adds the per-executor
// allowlist validation for executors that expose a server-side contract.
function validateExecutorRequest({ capability, capabilityRequirements, requestPayload }) {
  const identities = [
    ["capability", capability],
    ["request_payload.executor", requestPayload.executor],
    ["capability_requirements.executor", capabilityRequirements.executor],
  ];
  const isOpenVino = identities.some(([, v]) => v === "openvino.text_embedding");
  if (!isOpenVino) return null;
  // Every supplied executor identity must agree exactly; reject conflicts.
  for (const [name, value] of identities) {
    if (value !== undefined && value !== null && value !== "openvino.text_embedding") {
      return `Conflicting executor identity ${name}='${value}'; expected 'openvino.text_embedding'`;
    }
  }
  const { validateJobRequest } = require("./openvino-model-manifest");
  const error = validateJobRequest(requestPayload, null);
  if (error) return `OpenVINO request_payload invalid: ${error}`;
  return null;
}

async function sidekick_compute_jobs({ action, job_id, ...args }) {
  try {
    compute.initialize();
    switch (action) {
      case "list": return ok(compute.jobManager.listJobs({
        status: args.status,
        jobType: args.job_type,
        capability: args.capability,
        project: args.project,
        providerId: args.provider_id,
        workerId: args.worker_id,
        limit: args.limit,
      }));
      case "get": {
        if (!job_id) return err("job_id required");
        const j = compute.jobManager.getJob(job_id);
        return j ? ok(j) : err("Job not found");
      }
      case "create": {
        if (!args.job_type) return err("job_type is required for create (e.g. text_embedding)");

        // Build the request payload from an explicit structured field, or map
        // the convenience fields. Never default it to the raw argument object.
        let requestPayload;
        if (args.request_payload !== undefined) {
          if (!isPlainObject(args.request_payload)) return err("request_payload must be a JSON object");
          for (const f of ["prompt", "model", "provider"]) {
            if (args[f] !== undefined) return err(`Conflicting field '${f}': include it inside request_payload, not as a top-level argument`);
          }
          requestPayload = args.request_payload;
        } else {
          requestPayload = {};
          if (args.prompt !== undefined) requestPayload.prompt = args.prompt;
          if (args.model !== undefined) requestPayload.model = args.model;
          if (args.provider !== undefined) requestPayload.provider = args.provider;
        }

        if (args.capability_requirements !== undefined && !isPlainObject(args.capability_requirements)) {
          return err("capability_requirements must be a JSON object");
        }
        const capabilityRequirements = args.capability_requirements || {};

        const execError = validateExecutorRequest({ capability: args.capability, capabilityRequirements, requestPayload });
        if (execError) return err(execError);

        try {
          const j = compute.jobManager.createJob({
            jobType: args.job_type,
            capability: args.capability,          // preserved exactly by the job contract
            requestPayload,
            capabilityRequirements,
            dataClassification: args.data_classification, // undefined => contract default "private"
            timeoutMs: args.timeout_ms,
            maxAttempts: args.max_retries === undefined ? undefined : args.max_retries + 1,
            idempotencyKey: args.idempotency_key,
            project: args.project,
            source: "mcp",
          });
          return ok(j);
        } catch (e) {
          return err("compute_jobs create rejected: " + e.message);
        }
      }
      case "cancel": {
        if (!job_id) return err("job_id required");
        const j = compute.jobManager.cancelJob(job_id, { actor: "mcp", reason: args.reason || "user_cancelled" });
        return ok(j);
      }
      case "stats": return ok(compute.jobManager.getJobStats());
      case "artifacts": {
        if (!job_id) return err("job_id required");
        return ok(compute.jobManager.listArtifacts(job_id));
      }
      default: return err("Unknown action: " + action + ". Valid: list, get, create, cancel, stats, artifacts");
    }
  } catch (e) { return err("compute_jobs error: " + e.message); }
}

async function sidekick_compute_route({ action, ...args }) {
  try {
    compute.initialize();
    switch (action) {
      case "explain": return ok(compute.explainRouting(args));
      case "list_rules": return ok(compute.getRoutingRules());
      case "create_rule": {
        const dbStore = require("../db");
        const db = dbStore.getDb();
        const crypto = require("crypto");
        // Rules are operator preferences, but their stored arrays are parsed on
        // every routing decision — validate shape on write so a malformed rule
        // can never degrade routing: string-only IDs, bounded counts/lengths.
        for (const field of ["preferred_providers", "preferred_models", "preferred_workers", "fallback_providers"]) {
          const value = args[field];
          if (value === undefined) continue;
          if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== "string" || v.length === 0 || v.length > 200)) {
            return err(field + " must be an array of up to 50 non-empty id strings");
          }
        }
        const ruleId = "rule_" + Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");
        db.prepare(`
          INSERT INTO compute_routing_rules (
            rule_id, rule_name, priority, enabled, description, workload_class,
            capability_filter, data_classification_filter, trust_level_min,
            preferred_provider_ids_json, preferred_model_ids_json, preferred_worker_ids_json,
            fallback_provider_ids_json, max_latency_ms, require_vision, require_tools, require_embedding
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ruleId, args.rule_name || "unnamed", args.priority || 50,
          args.description || null, args.workload_class || null,
          args.capability_filter || null, args.data_classification_filter || null,
          args.trust_level_min || null,
          JSON.stringify(args.preferred_providers || []),
          JSON.stringify(args.preferred_models || []),
          JSON.stringify(args.preferred_workers || []),
          JSON.stringify(args.fallback_providers || []),
          args.max_latency_ms || null,
          args.require_vision ? 1 : 0, args.require_tools ? 1 : 0, args.require_embedding ? 1 : 0
        );
        return ok({ ruleId, created: true });
      }
      case "delete_rule": {
        if (!args.rule_id) return err("rule_id required");
        const dbStore = require("../db");
        const db = dbStore.getDb();
        db.prepare("DELETE FROM compute_routing_rules WHERE rule_id = ?").run(args.rule_id);
        return ok({ deleted: true });
      }
      default: return err("Unknown action: " + action + ". Valid: explain, list_rules, create_rule, delete_rule");
    }
  } catch (e) { return err("compute_route error: " + e.message); }
}

module.exports = {
  sidekick_compute,
  sidekick_compute_nodes,
  sidekick_compute_providers,
  sidekick_compute_models,
  sidekick_compute_jobs,
  sidekick_compute_route,
};
