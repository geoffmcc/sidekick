const compute = require("./index");

function ok(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function err(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
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
      case "list": return ok(compute.providerRegistry.listProviders(args));
      case "get": {
        if (!provider_id) return err("provider_id required");
        const p = compute.providerRegistry.getProvider(provider_id);
        return p ? ok(p) : err("Provider not found");
      }
      case "create": {
        const p = compute.providerRegistry.createProvider(args);
        return ok(p);
      }
      case "update": {
        if (!provider_id) return err("provider_id required");
        const p = compute.providerRegistry.updateProvider(provider_id, args);
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
      case "list": return ok(compute.modelRegistry.listModels(args));
      case "get": {
        if (!model_id) return err("model_id required");
        const m = compute.modelRegistry.getModel(model_id);
        return m ? ok(m) : err("Model not found");
      }
      case "create": {
        const m = compute.modelRegistry.createModel(args);
        return ok(m);
      }
      case "update": {
        if (!model_id) return err("model_id required");
        const m = compute.modelRegistry.updateModel(model_id, args);
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
