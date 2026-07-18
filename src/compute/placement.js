"use strict";

/**
 * Compute Placement v1 — the shared, authoritative placement decision core.
 *
 * Both routing paths delegate candidate evaluation here so their decisions
 * cannot drift:
 *   - direct inference (inference-service chat/generate/embed) evaluates
 *     provider+model candidates;
 *   - distributed jobs (job-manager workerCompatibility/claimNextJob)
 *     evaluate worker+executor+model candidates.
 *
 * The module is deliberately pure at decision time: predicates read registry
 * snapshots and never mutate provider health, circuit state, or worker rows,
 * which is what makes `explainPlacement` (dry run) reuse the exact same code
 * as real placement with zero side effects and zero execution.
 *
 * Trust model: placement requests are untrusted caller input (strict versioned
 * schema, unknown and forbidden fields rejected, data classification is
 * mandatory). Worker capability reports are semi-trusted: the OpenVINO model
 * manifest — not the worker's claimed certification tier — is the only
 * authority for "certified", and a worker claim can only downgrade, never
 * upgrade, a tier. Routing rules are operator preferences applied strictly
 * AFTER the security gates; they can narrow or order candidates but never
 * re-admit a candidate that failed classification, trust, certification, or
 * concurrency.
 */

const providerRegistry = require("./provider-registry");
const modelRegistry = require("./model-registry");
const manifest = require("./openvino-model-manifest");
const { ComputeError, DATA_CLASSIFICATIONS, TRUST_LEVELS, CIRCUIT_STATES } = require("./errors");

const PLACEMENT_VERSION = 1;

const PLACEMENT_CAPABILITIES = Object.freeze(["embeddings", "chat", "generate"]);

// "private" is the legacy compute_providers schema default from before the
// trust taxonomy existed; it labeled first-party infrastructure and ranks as
// "trusted". Genuinely unknown labels still rank as untrusted (fail-closed).
const TRUST_ORDER = Object.freeze({ untrusted: 0, limited: 1, trusted: 2, private: 2, privileged: 3 });

// Fields a caller must never control. Presence anywhere in a placement request
// or a job's caller-supplied objects is an explicit rejection, not a silent
// drop: endpoints/credentials select infrastructure, device/worker pinning
// bypasses certification, trust/provenance fields forge the audit trail.
const FORBIDDEN_FIELDS = Object.freeze([
  "endpoint", "url", "base_url", "baseurl",
  "credential", "credentials", "api_key", "apikey", "token", "secret", "auth",
  "device", "device_string", "accelerator", "actual_accelerator", "requested_accelerator",
  "worker", "worker_id", "workerid",
  "trust_level", "trustlevel", "trust",
  "provenance", "fallback_occurred", "verified",
  "command", "argv", "executable", "shell", "script", "path", "model_path",
]);

const REQUEST_ALLOWED_KEYS = Object.freeze(["version", "capability", "workload_class", "data_classification", "trust_level_required", "requirements", "preferences"]);
const REQUIREMENT_ALLOWED_KEYS = Object.freeze(["tools", "vision", "structured_output", "dimensions", "context_limit", "sequence_length"]);
const PREFERENCE_ALLOWED_KEYS = Object.freeze(["allow_fallback"]);

class PlacementError extends ComputeError {
  constructor(message, details = {}) {
    super(message, "PLACEMENT_INVALID", details);
    this.name = "PlacementError";
  }
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "_");
}

/**
 * Reject any caller-supplied object tree containing a forbidden
 * infrastructure/identity/provenance field. Used both by the placement request
 * schema and as the job-creation choke point over requestPayload /
 * capabilityRequirements / routingPreferences (executor and model selectors in
 * those objects remain allowed — they are validated against allowlists by the
 * job contract and the OpenVINO manifest, not here).
 */
function assertNoForbiddenFields(value, path = "request", { allow = [] } = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoForbiddenFields(item, `${path}[${i}]`, { allow }));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const norm = normalizedKey(key);
    if (FORBIDDEN_FIELDS.includes(norm) && !allow.includes(norm)) {
      throw new PlacementError(`Field '${key}' is not permitted in ${path}: callers cannot select endpoints, credentials, devices, workers, trust, or provenance`, { field: key, path });
    }
    assertNoForbiddenFields(value[key], `${path}.${key}`, { allow });
  }
}

function assertAllowedKeys(obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PlacementError(`Unknown field '${key}' in ${path}`, { field: key, path });
    }
  }
}

/**
 * Strict, versioned validation of a logical placement request. Fail-closed:
 * unknown fields are rejected, data_classification is mandatory (a missing
 * classification must never mean "unrestricted"), and only logical
 * requirements/preferences are accepted.
 */
function validatePlacementRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new PlacementError("Placement request must be an object");
  }
  assertAllowedKeys(request, REQUEST_ALLOWED_KEYS, "request");
  const version = request.version === undefined ? PLACEMENT_VERSION : request.version;
  if (Number(version) !== PLACEMENT_VERSION) {
    throw new PlacementError(`Unsupported placement request version: ${version}`, { version });
  }
  if (typeof request.capability !== "string" || !PLACEMENT_CAPABILITIES.includes(request.capability)) {
    throw new PlacementError(`Unsupported placement capability: ${request.capability}. Supported: ${PLACEMENT_CAPABILITIES.join(", ")}`, { capability: request.capability });
  }
  if (typeof request.data_classification !== "string" || !DATA_CLASSIFICATIONS.includes(request.data_classification)) {
    throw new PlacementError("data_classification is required and must be one of: " + DATA_CLASSIFICATIONS.join(", "), { data_classification: request.data_classification });
  }
  const trustRequired = request.trust_level_required === undefined ? "trusted" : request.trust_level_required;
  if (!TRUST_LEVELS.includes(trustRequired)) {
    throw new PlacementError("trust_level_required must be one of: " + TRUST_LEVELS.join(", "), { trust_level_required: request.trust_level_required });
  }
  if (request.workload_class !== undefined && typeof request.workload_class !== "string") {
    throw new PlacementError("workload_class must be a string");
  }
  const requirements = request.requirements === undefined ? {} : request.requirements;
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new PlacementError("requirements must be an object");
  }
  assertAllowedKeys(requirements, REQUIREMENT_ALLOWED_KEYS, "requirements");
  for (const flag of ["tools", "vision", "structured_output"]) {
    if (requirements[flag] !== undefined && typeof requirements[flag] !== "boolean") {
      throw new PlacementError(`requirements.${flag} must be a boolean`);
    }
  }
  for (const num of ["dimensions", "context_limit", "sequence_length"]) {
    if (requirements[num] !== undefined && (!Number.isInteger(requirements[num]) || requirements[num] <= 0 || requirements[num] > 10_000_000)) {
      throw new PlacementError(`requirements.${num} must be a positive integer`);
    }
  }
  const preferences = request.preferences === undefined ? {} : request.preferences;
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
    throw new PlacementError("preferences must be an object");
  }
  assertAllowedKeys(preferences, PREFERENCE_ALLOWED_KEYS, "preferences");
  if (preferences.allow_fallback !== undefined && typeof preferences.allow_fallback !== "boolean") {
    throw new PlacementError("preferences.allow_fallback must be a boolean");
  }
  return {
    version: PLACEMENT_VERSION,
    capability: request.capability,
    workloadClass: request.workload_class || null,
    dataClassification: request.data_classification,
    trustLevelRequired: trustRequired,
    requirements: {
      tools: requirements.tools === true,
      vision: requirements.vision === true,
      structuredOutput: requirements.structured_output === true,
      dimensions: requirements.dimensions || null,
      contextLimit: requirements.context_limit || null,
      sequenceLength: requirements.sequence_length || null,
    },
    preferences: {
      allowFallback: preferences.allow_fallback !== false,
    },
  };
}

function trustRank(level) {
  // Unknown/legacy trust labels rank as untrusted (fail-closed).
  return TRUST_ORDER[level] ?? 0;
}

/**
 * Pure predicate: can this provider+model pair serve the validated request?
 * Identical gates for real placement and explain; no side effects.
 */
function evaluateProviderCandidate(validated, provider, model) {
  const reasons = [];
  if (!provider.enabled) reasons.push("provider_disabled");
  if (provider.health.circuitState === CIRCUIT_STATES.OPEN) reasons.push("circuit_open");
  if (provider.health.status === "disabled" || provider.health.status === "maintenance") reasons.push("provider_unavailable");
  if (!provider.dataClassifications.includes(validated.dataClassification)) reasons.push("data_classification_denied");
  if (trustRank(provider.trustLevel) < trustRank(validated.trustLevelRequired)) reasons.push("trust_too_low");
  if (!model) {
    reasons.push("model_missing");
    return { ok: false, reasons };
  }
  if (!model.enabled) reasons.push("model_disabled");
  if (model.deprecated) reasons.push("model_deprecated");
  const caps = model.capabilities || [];
  const capabilityOk = caps.includes(validated.capability) ||
    (validated.capability === "embeddings" && model.supportsEmbedding);
  if (!capabilityOk) reasons.push("capability_missing");
  if (validated.requirements.tools && !model.supportsTools) reasons.push("tools_unsupported");
  if (validated.requirements.vision && !model.supportsVision) reasons.push("vision_unsupported");
  if (validated.requirements.structuredOutput && !model.supportsStructuredOutput) reasons.push("structured_output_unsupported");
  if (validated.requirements.contextLimit && model.contextLimit && model.contextLimit < validated.requirements.contextLimit) reasons.push("context_window_too_small");
  return { ok: reasons.length === 0, reasons };
}

function parseMaybeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") { try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

function workerExecutorTypes(worker) {
  return parseMaybeArray(worker.executors).map(e => typeof e === "string" ? e : (e.type || e.name)).filter(Boolean);
}

function workerModelNames(worker) {
  return parseMaybeArray(worker.modelInventory).map(m => typeof m === "string" ? m : (m.name || m.model || m.providerModelName)).filter(Boolean);
}

function workerClaimedTier(worker, modelName) {
  for (const m of parseMaybeArray(worker.modelInventory)) {
    if (typeof m === "object" && m !== null && (m.name || m.model || m.providerModelName) === modelName && m.certificationTier) {
      return m.certificationTier;
    }
  }
  for (const exec of parseMaybeArray(worker.executors)) {
    if (typeof exec !== "object" || !Array.isArray(exec.capabilities)) continue;
    for (const cap of exec.capabilities) {
      const parts = String(cap).split(":");
      if (parts.length >= 6 && parts[1] === modelName && parts[5]) return parts[5];
    }
  }
  return null;
}

/**
 * Server-authoritative certification: the OpenVINO manifest decides whether a
 * model/device pair is certified. A worker's claimed tier can only DOWNGRADE
 * the manifest tier (a worker admitting it self-tested), never upgrade an
 * unknown or unsupported model to certified.
 */
function certificationFor(modelName, { claimedTier = null } = {}) {
  const approved = manifest.getApprovedModel(modelName);
  if (!approved) return { tier: claimedTier === "certified" ? "unverified" : (claimedTier || "unverified"), approved: null };
  const manifestTier = manifest.statusToTier(approved.status);
  const order = { unsupported: 0, unverified: 0, detected_self_tested: 1, certified: 2 };
  const claimed = claimedTier && order[claimedTier] !== undefined ? claimedTier : manifestTier;
  const tier = (order[claimed] ?? 0) < (order[manifestTier] ?? 0) ? claimed : manifestTier;
  return { tier, approved };
}

const DEFAULT_WORKER_CLASSIFICATIONS = Object.freeze(["public", "internal", "private"]);

/**
 * Pure predicate: can this worker serve the validated request (or job-derived
 * requirement set)? Reason codes are stable and sanitized for explain output.
 *
 * `needs` may carry job-derived selectors: { executor, model }.
 */
function evaluateWorkerCandidate(validated, worker, needs = {}, { activeExecutorCounts = null } = {}) {
  const reasons = [];
  if (!worker) return { ok: false, reasons: ["worker_missing"], tier: null };
  if (worker.state !== "online") reasons.push("worker_offline");
  if (worker.maintenanceMode || worker.adminState === "maintenance" || worker.adminState === "draining") reasons.push("worker_maintenance");
  if (worker.lastHeartbeat && Date.now() - new Date(worker.lastHeartbeat).getTime() > 120000) reasons.push("worker_stale");
  if (worker.protocolVersion !== "1") reasons.push("protocol_mismatch");
  if (Number(worker.currentJobs) >= Number(worker.maxConcurrentJobs)) reasons.push("concurrency_exhausted");

  const allowedClassifications = Array.isArray(worker.allowedDataClassifications) && worker.allowedDataClassifications.length > 0
    ? worker.allowedDataClassifications
    : DEFAULT_WORKER_CLASSIFICATIONS;
  if (!allowedClassifications.includes(validated.dataClassification)) reasons.push("data_classification_denied");
  if (trustRank(worker.trustLevel) < trustRank(validated.trustLevelRequired)) reasons.push("trust_too_low");

  const executors = workerExecutorTypes(worker);
  const models = workerModelNames(worker);
  const requiredExecutor = needs.executor || null;
  const requiredModel = needs.model || null;
  if (requiredExecutor && !executors.includes(requiredExecutor)) reasons.push("executor_missing");
  if (requiredModel && models.length > 0 && !models.includes(requiredModel)) reasons.push("model_missing");

  // Per-executor concurrency: the OpenVINO executor keeps a single resident
  // NPU model (helper maxConcurrent: 1); a second simultaneous lease for the
  // same executor on one worker must be refused even when the worker-wide
  // limit still has headroom.
  if (requiredExecutor && activeExecutorCounts) {
    const active = Number(activeExecutorCounts[requiredExecutor] || 0);
    const limit = perExecutorConcurrencyLimit(requiredExecutor);
    if (limit !== null && active >= limit) reasons.push("concurrency_exhausted");
  }

  let tier = null;
  let accelerator = null;
  if (requiredModel) {
    const cert = certificationFor(requiredModel, { claimedTier: workerClaimedTier(worker, requiredModel) });
    tier = cert.tier;
    if (cert.approved) {
      accelerator = cert.approved.certifiedDevice || null;
      if (requiredExecutor === "openvino.text_embedding" && tier !== "certified" && tier !== "detected_self_tested") {
        reasons.push("model_not_certified");
      }
      if (validated.requirements.sequenceLength && Array.isArray(cert.approved.certifiedSequenceLengths) &&
          !cert.approved.certifiedSequenceLengths.includes(validated.requirements.sequenceLength)) {
        reasons.push("static_shape_required");
      }
      if (validated.requirements.dimensions && cert.approved.outputDimensions &&
          cert.approved.outputDimensions !== validated.requirements.dimensions) {
        reasons.push("dimensions_mismatch");
      }
    } else if (requiredExecutor === "openvino.text_embedding") {
      // OpenVINO execution is manifest-allowlisted; an unlisted model can never
      // be placed on that executor regardless of what the worker advertises.
      reasons.push("model_not_certified");
    }
  }

  return { ok: reasons.length === 0, reasons, tier, accelerator };
}

function perExecutorConcurrencyLimit(executorType) {
  // The registry's resource limits are authoritative where declared.
  try {
    const executorRegistry = require("./executor-registry");
    const def = executorRegistry.getExecutor(executorType);
    if (def && def.resourceLimits && Number.isInteger(def.resourceLimits.maxConcurrent)) {
      return def.resourceLimits.maxConcurrent;
    }
  } catch {}
  if (executorType === "openvino.text_embedding") return 1;
  return null;
}

function sanitizeProviderCandidate(provider, model) {
  return {
    provider_id: provider.providerId,
    provider_type: provider.providerType,
    model_id: model ? model.modelId : null,
    model_name: model ? model.providerModelName : null,
    trust_level: provider.trustLevel,
    health: provider.health.status,
  };
}

function sanitizeWorkerCandidate(worker, needs, evaluation) {
  return {
    worker_id: worker.workerId,
    executor: needs.executor || null,
    model_name: needs.model || null,
    trust_level: worker.trustLevel,
    state: worker.state,
    certification_tier: evaluation.tier || null,
  };
}

function providerScore(provider) {
  let score = provider.priority;
  if (provider.health.status === "healthy") score += 20;
  else if (provider.health.status === "degraded") score -= 10;
  if (provider.health.failureCount > 0) score -= provider.health.failureCount * 5;
  if (provider.health.circuitState === CIRCUIT_STATES.HALF_OPEN) score -= 15;
  return score;
}

function matchRoutingRule(validated) {
  // Reuse the existing rule store; rules are preferences applied over an
  // already gate-passing candidate set and can never re-admit a candidate.
  try {
    const capabilityRouter = require("./capability-router");
    return capabilityRouter.matchRoutingRule({
      capability: validated.capability,
      workloadClass: validated.workloadClass,
      dataClassification: validated.dataClassification,
      trustLevel: validated.trustLevelRequired,
      requiresVision: validated.requirements.vision,
      requiresTools: validated.requirements.tools,
      requiresEmbedding: validated.capability === "embeddings",
    });
  } catch { return null; }
}

/**
 * Rank provider+model candidates for a validated request. Shared by real
 * selection (inference-service) and explain. Returns gate-passing candidates
 * ordered best-first plus sanitized rejections.
 */
function rankProviderCandidates(validated) {
  const eligible = [];
  const rejected = [];
  const rule = matchRoutingRule(validated);
  for (const provider of providerRegistry.listProviders({ enabled: true })) {
    const models = modelRegistry.listModels({ providerId: provider.providerId, enabled: true });
    if (models.length === 0) {
      rejected.push({ ...sanitizeProviderCandidate(provider, null), reasons: ["model_missing"] });
      continue;
    }
    let best = null;
    let bestRejection = null;
    for (const model of models) {
      const evaluation = evaluateProviderCandidate(validated, provider, model);
      if (evaluation.ok) {
        const preferredByRule = rule && rule.preferredModels.includes(model.modelId);
        const score = (model.benchmarkScore || 50) + (preferredByRule ? 1000 : 0);
        if (!best || score > best.modelScore) best = { provider, model, modelScore: score };
      } else if (!bestRejection) {
        bestRejection = { ...sanitizeProviderCandidate(provider, model), reasons: evaluation.reasons };
      }
    }
    if (best) eligible.push(best);
    else if (bestRejection) rejected.push(bestRejection);
  }
  const preferredProviders = rule ? rule.preferredProviders : [];
  eligible.sort((a, b) => {
    const prefA = preferredProviders.includes(a.provider.providerId) ? 1 : 0;
    const prefB = preferredProviders.includes(b.provider.providerId) ? 1 : 0;
    if (prefA !== prefB) return prefB - prefA;
    const scoreDiff = providerScore(b.provider) - providerScore(a.provider);
    if (scoreDiff !== 0) return scoreDiff;
    return b.modelScore - a.modelScore;
  });
  return { eligible, rejected, rule };
}

/**
 * Rank worker candidates for a validated request (embeddings-focused in v1:
 * the certified OpenVINO path). Shared by explain; the claim path evaluates a
 * specific worker against a specific job with the same predicate.
 */
function rankWorkerCandidates(validated, { workers = null, needs = {} } = {}) {
  const workerManager = require("./worker-manager");
  const candidates = workers || workerManager.listWorkers();
  const eligible = [];
  const rejected = [];
  for (const worker of candidates) {
    const evaluation = evaluateWorkerCandidate(validated, worker, needs);
    if (evaluation.ok) eligible.push({ worker, evaluation });
    else rejected.push({ ...sanitizeWorkerCandidate(worker, needs, evaluation), reasons: evaluation.reasons });
  }
  const tierOrder = { certified: 2, detected_self_tested: 1 };
  eligible.sort((a, b) => (tierOrder[b.evaluation.tier] || 0) - (tierOrder[a.evaluation.tier] || 0));
  return { eligible, rejected };
}

/**
 * Produce the structured, explainable placement decision for a logical
 * request. Performs no execution and no state mutation. The decision reflects
 * both candidate classes; `selected.execution_path` states which existing
 * execution surface serves it ("provider" = direct inference adapters,
 * "worker_job" = the compute job/lease path).
 */
function decidePlacement(request) {
  const validated = validatePlacementRequest(request);
  const decision = {
    version: PLACEMENT_VERSION,
    capability: validated.capability,
    selected: null,
    reason: null,
    fallbacks: [],
    rejected: [],
    policy: {
      data_classification: validated.dataClassification,
      trust_level_required: validated.trustLevelRequired,
      fallback_allowed: validated.preferences.allowFallback,
    },
  };

  if (validated.capability === "embeddings") {
    // Preferred: certified OpenVINO embedding on an enrolled, healthy worker,
    // NPU-certified models first.
    const embeddingModels = manifest.listApprovedModels()
      .filter(m => m.taskType === "text_embedding")
      .sort((a, b) => (b.certifiedDevice === "NPU" ? 1 : 0) - (a.certifiedDevice === "NPU" ? 1 : 0));
    for (const approved of embeddingModels) {
      const needs = { executor: "openvino.text_embedding", model: approved.modelId };
      const { eligible, rejected } = rankWorkerCandidates(validated, { needs });
      decision.rejected.push(...rejected);
      const npuFirst = eligible.filter(c => c.evaluation.tier === "certified");
      if (npuFirst.length > 0) {
        const pick = npuFirst[0];
        decision.selected = {
          provider_id: null,
          model_id: approved.modelId,
          worker_id: pick.worker.workerId,
          executor: "openvino.text_embedding",
          accelerator: approved.certifiedDevice,
          execution_path: "worker_job",
        };
        decision.reason = approved.certifiedDevice === "NPU" ? "preferred_certified_npu_embedding" : "certified_openvino_embedding";
        if (approved.fallbackDevice && validated.preferences.allowFallback) {
          decision.fallbacks.push({ executor: "openvino.text_embedding", accelerator: approved.fallbackDevice, reason: "npu_unavailable", policy: approved.defaultFallbackPolicy || "same_model_cpu" });
        } else if (approved.fallbackDevice) {
          decision.rejected.push({ executor: "openvino.text_embedding", accelerator: approved.fallbackDevice, reasons: ["fallback_disabled"] });
        }
        break;
      }
    }
  }

  // Provider-mode candidates: primary for chat/generate, fallback tier for
  // embeddings when no certified worker path is available.
  const { eligible, rejected } = rankProviderCandidates(validated);
  decision.rejected.push(...rejected);
  if (!decision.selected) {
    if (eligible.length > 0) {
      const pick = eligible[0];
      decision.selected = {
        provider_id: pick.provider.providerId,
        model_id: pick.model.modelId,
        worker_id: null,
        executor: pick.provider.providerType === "ollama" ? "ollama.inference" : null,
        accelerator: null,
        execution_path: "provider",
      };
      decision.reason = validated.capability === "embeddings" ? "provider_embedding_fallback" : (pick.provider.providerType === "ollama" ? "preferred_ollama_generation" : "best_available_provider");
      // GPU use by a provider is expectation, never verified fact.
      if (pick.provider.providerType === "ollama") {
        decision.policy.accelerator_note = "GPU-backed provider requested or expected; actual device not independently verified.";
      }
    } else {
      decision.reason = "no_eligible_candidate";
    }
  }
  if (decision.selected && validated.preferences.allowFallback) {
    for (const alt of eligible.slice(0, 3)) {
      if (decision.selected.provider_id === alt.provider.providerId) continue;
      decision.fallbacks.push({
        provider_id: alt.provider.providerId,
        model_id: alt.model.modelId,
        executor: alt.provider.providerType === "ollama" ? "ollama.inference" : null,
        accelerator: null,
        reason: "provider_fallback",
      });
    }
  }
  return decision;
}

/**
 * Dry-run: the same decision code with no execution and no mutation, plus the
 * validated request echo for observability. Output is sanitized — candidate
 * summaries never include endpoints, credentials, or raw health/limits blobs.
 */
function explainPlacement(request) {
  const decision = decidePlacement(request);
  return { ...decision, dry_run: true };
}

module.exports = {
  PLACEMENT_VERSION,
  PLACEMENT_CAPABILITIES,
  PlacementError,
  validatePlacementRequest,
  assertNoForbiddenFields,
  evaluateProviderCandidate,
  evaluateWorkerCandidate,
  certificationFor,
  perExecutorConcurrencyLimit,
  rankProviderCandidates,
  rankWorkerCandidates,
  decidePlacement,
  explainPlacement,
  TRUST_ORDER,
};
