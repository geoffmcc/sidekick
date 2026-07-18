"use strict";

/**
 * OpenVINO NPU Text Embedding Executor
 *
 * Registered executor type: "openvino.text_embedding"
 *
 * This module:
 *   1. Validates all job input against the approved model manifest.
 *   2. Delegates inference to the HelperManager.
 *   3. Validates the helper response before accepting it as a result.
 *   4. Reports accurate backend provenance (never silently accepts CPU fallback).
 *   5. Integrates with the existing executor-registry framework.
 *
 * Security: No caller-supplied paths, device strings, tensor shapes, or
 * executable references are ever forwarded to the helper.
 */

const crypto = require("crypto");

const { HelperManager } = require("./openvino-helper-manager");
const { loadOpenVinoConfig } = require("./openvino-config");
const {
  validateJobRequest,
  getApprovedModel,
  getAdvertisedCapabilities,
  listApprovedModels,
  verifyModelIntegrity,
  statusToTier,
  CERTIFICATION_TIER,
} = require("./openvino-model-manifest");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXECUTOR_TYPE = "openvino.text_embedding";
const EXECUTOR_VERSION = "1";

// Minimum allowed embedding norm (reject near-zero / degenerate embeddings).
const MIN_EMBEDDING_NORM = 0.99;
const MAX_EMBEDDING_NORM = 1.01;

// Default bound for the whole startup-readiness path (helper start + device
// enumeration + per-model readiness probes).  Overridable by the caller.
const DEFAULT_STARTUP_READINESS_MS = 60000;

// Honest startup states advertised to the worker (see awaitStartupReadiness).
const READINESS_STATE = Object.freeze({
  DISABLED: "disabled",     // Feature not enabled on this worker.
  PROBING: "probing",       // Initialisation in progress; nothing established yet.
  READY: "ready",           // At least one certified profile passed its readiness probe.
  UNAVAILABLE: "unavailable", // Helper up, devices known, but no certified profile is ready.
  FAULTED: "faulted",       // Config/helper fault or the readiness path timed out.
});

// ---------------------------------------------------------------------------
// Module-level state (one manager per executor instance)
// ---------------------------------------------------------------------------

let _config = null;
let _manager = null;
let _initError = null;
let _availableDevices = new Set();

// Cached readiness snapshot established by awaitStartupReadiness().  Read
// synchronously by the worker when it builds heartbeat/enrollment payloads so
// executor capabilities and model inventory always agree.
let _readiness = null;
// True once shutdown has been requested; aborts any in-flight readiness wait.
let _shutdownRequested = false;
// Abort hook for a pending readiness wait (set while awaiting device discovery).
let _readinessAbort = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function _log(level, msg, meta = {}) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    lvl: level,
    component: "openvino-executor",
    msg,
    ...meta,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(entry + "\n");
  } else {
    process.stderr.write(entry + "\n");
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise the OpenVINO executor.  This must be called once at worker
 * startup.  Registers the executor in the executor-registry if config is
 * valid and the feature is enabled.
 *
 * @param {object} [overrideConfig]  Optional pre-loaded config (for testing).
 * @returns {{ enabled: boolean, error: string|null, capabilities: string[] }}
 */
async function initOpenVinoExecutor(overrideConfig) {
  // Reset per-init state so a re-initialisation starts from a clean slate.
  _initError = null;
  _availableDevices = new Set();
  _readiness = null;
  _shutdownRequested = false;
  _readinessAbort = null;
  // Defensively stop any previously running helper before replacing it.
  if (_manager) {
    try { _manager.shutdown(); } catch { /* best effort */ }
    _manager = null;
  }

  try {
    _config = overrideConfig || loadOpenVinoConfig();
  } catch (err) {
    _initError = err.message;
    _log("error", "OpenVINO config invalid; executor disabled", {
      error: err.message,
    });
    return { enabled: false, error: err.message, capabilities: [] };
  }

  if (!_config.enabled) {
    _log("info", "OpenVINO executor is disabled (SIDEKICK_OPENVINO_ENABLED != true)");
    return { enabled: false, error: null, capabilities: [] };
  }

  _manager = new HelperManager(_config, _log);

  // Listen for helper restart events to update device availability.
  _manager.on("helperReady", (info) => {
    _availableDevices = new Set(Array.isArray(info.availableDevices)
      ? info.availableDevices.filter((d) => typeof d === "string")
      : []);
    _log("info", "Helper ready; devices updated", {
      devices: Array.from(_availableDevices),
    });
  });

  _manager.on("helperExited", ({ reason, restartCount }) => {
    _log("warn", "Helper exited", { reason, restartCount });
  });

  // Lazy start — do not block executor registration on helper startup.
  // The first inference request will trigger a start attempt.
  // However, we do a background start so the helper is warm before first use.
  _manager.start().catch((err) => {
    _log("warn", "Background helper start failed (will retry on first request)", {
      error: err.message,
    });
  });

  _log("info", "OpenVINO executor initialised", {
    pythonPath: _config.pythonPath,
    helperScript: _config.helperScript,
    modelsDir: _config.modelsDir,
    inferenceTimeoutMs: _config.inferenceTimeoutMs,
    fallbackPolicy: _config.fallbackPolicy,
  });

  return {
    enabled: true,
    error: null,
    capabilities: [], // Updated dynamically from device discovery.
  };
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/**
 * Return the set of capability strings that should be advertised by the worker.
 *
 * Only returns capabilities for devices that are actually available in the
 * running helper.
 *
 * @returns {string[]}
 */
function getOpenVinoCapabilities() {
  if (!_config || !_config.enabled) return [];

  const devices = _availableDevices;

  const caps = [];
  for (const cap of getAdvertisedCapabilities("e5-small-v2-qint8", devices)) {
    caps.push(cap);
  }
  for (const cap of getAdvertisedCapabilities("qwen3-embedding-0.6b-int8", devices)) {
    caps.push(cap);
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Capability detection status (for dashboard / health endpoint)
// ---------------------------------------------------------------------------

/**
 * Return structured capability status for diagnostics.
 *
 * @returns {object}
 */
function getCapabilityStatus() {
  if (!_config) {
    return {
      status: "unconfigured",
      reason: "OpenVINO executor not initialised",
      capabilities: [],
    };
  }
  if (!_config.enabled) {
    return {
      status: "disabled",
      reason: "SIDEKICK_OPENVINO_ENABLED is not 'true'",
      capabilities: [],
    };
  }
  if (_initError) {
    return {
      status: "config_error",
      reason: _initError,
      capabilities: [],
    };
  }

  const devices = Array.from(_availableDevices);
  const capabilities = getOpenVinoCapabilities();

  if (devices.length === 0) {
    return {
      status: "starting",
      reason: "Helper not yet ready; device list pending",
      capabilities: [],
      helperStatus: _manager ? _manager.getStatus() : null,
    };
  }

  const hasNpu = devices.includes("NPU");

  return {
    status: hasNpu ? "ready" : "npu_unavailable",
    reason: hasNpu
      ? "NPU detected and helper ready"
      : "NPU not enumerated by OpenVINO; CPU embedding available only",
    availableDevices: devices,
    capabilities,
    openVinoVersion: _manager?._helper?.openVinoVersion || null,
    helperVersion: _manager?._helper?.helperVersion || null,
    helperStatus: _manager ? _manager.getStatus() : null,
    fallbackPolicy: _config.fallbackPolicy,
    modelsDir: _config.modelsDir,  // For operator diagnostics; no sensitive detail.
  };
}

// ---------------------------------------------------------------------------
// Startup readiness (bounded; establishes what is honestly ready before the
// worker advertises itself)
// ---------------------------------------------------------------------------

/**
 * Return the last established startup-readiness snapshot.
 *
 * Synchronous and side-effect free so the worker can read it while building
 * every heartbeat/enrollment payload.  When awaitStartupReadiness() has not yet
 * run, returns an honest interim state (disabled / faulted / probing) derived
 * from the current config.
 *
 * @returns {{ state: string, reason: string, availableDevices: string[],
 *   capabilities: string[], models: object[], openVinoVersion: (string|null),
 *   helperVersion: (string|null), probedAt: (string|null) }}
 */
function getStartupReadiness() {
  if (_readiness) return _readiness;

  const base = {
    availableDevices: [],
    capabilities: [],
    models: [],
    openVinoVersion: null,
    helperVersion: null,
    probedAt: null,
    integrity: { ok: true, models: [], manifestMismatch: false },
  };

  if (!_config) {
    const enabled = process.env.SIDEKICK_OPENVINO_ENABLED === "true";
    return {
      ...base,
      state: enabled ? READINESS_STATE.PROBING : READINESS_STATE.DISABLED,
      reason: enabled
        ? "OpenVINO executor not yet initialised"
        : "SIDEKICK_OPENVINO_ENABLED is not 'true'",
    };
  }
  if (!_config.enabled) {
    return { ...base, state: READINESS_STATE.DISABLED, reason: "OpenVINO executor is disabled" };
  }
  if (_initError) {
    return { ...base, state: READINESS_STATE.FAULTED, reason: _initError };
  }
  return {
    ...base,
    state: READINESS_STATE.PROBING,
    reason: "Startup readiness has not been established yet",
  };
}

/**
 * Wait (bounded) for the helper to enumerate its OpenVINO devices, or fault.
 *
 * Resolves once devices are known; rejects on helper exit, shutdown request, or
 * when the deadline passes.  Never waits longer than the supplied deadline.
 *
 * @param {number} deadline  Absolute epoch-ms deadline.
 * @returns {Promise<void>}
 */
function _waitForDevices(deadline) {
  if (_availableDevices.size > 0) return Promise.resolve();
  if (_shutdownRequested) {
    return Promise.reject(new Error("shutdown requested during initialization"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (_manager) {
        _manager.removeListener("helperReady", onReady);
        _manager.removeListener("helperExited", onExit);
      }
      _readinessAbort = null;
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onExit = ({ reason } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`helper exited during startup: ${reason || "unknown"}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("helper did not become ready before the startup deadline"));
    }, Math.max(0, deadline - Date.now()));

    // Allow an external shutdown to abort this wait promptly.
    _readinessAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("shutdown requested during initialization"));
    };

    _manager.on("helperReady", onReady);
    _manager.on("helperExited", onExit);

    // Guard against the helper having become ready between the size check and
    // attaching the listener.
    if (_availableDevices.size > 0) onReady();
  });
}

/**
 * Establish, within a bounded time budget, which certified profiles are
 * genuinely ready, and cache an honest readiness snapshot.
 *
 * Behaviour:
 *   - Never claims a profile is ready without an actual helper `ready` probe
 *     succeeding for that model's certified device (no compile is forced, so
 *     lazy compilation is preserved; the claimed readiness level is "device
 *     enumerated + model files present").
 *   - A capability string is only advertised for the exact device its own probe
 *     validated.  A missing NPU therefore yields no NPU capabilities but does
 *     not suppress CPU-certified profiles (e.g. E5 on CPU).
 *   - Never derives a fallback (CPU) capability from an NPU model's probe.
 *
 * @param {number} [timeoutMs]  Total budget for the readiness path.
 * @returns {Promise<object>}   The readiness snapshot (also cached).
 */
async function awaitStartupReadiness(timeoutMs) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_STARTUP_READINESS_MS;
  const deadline = Date.now() + budget;

  if (!_config || !_config.enabled) {
    _readiness = getStartupReadiness();
    return _readiness;
  }
  if (_initError) {
    _readiness = { ...getStartupReadiness(), state: READINESS_STATE.FAULTED, reason: _initError };
    return _readiness;
  }
  if (_shutdownRequested || !_manager) {
    _readiness = {
      state: READINESS_STATE.FAULTED,
      reason: _shutdownRequested
        ? "shutdown requested during initialization"
        : "helper manager not initialised",
      availableDevices: [],
      capabilities: [],
      models: [],
      openVinoVersion: null,
      helperVersion: null,
      probedAt: new Date().toISOString(),
      integrity: { ok: true, models: [], manifestMismatch: false },
    };
    return _readiness;
  }

  // 1. Wait for device enumeration (bounded).
  try {
    await _waitForDevices(deadline);
  } catch (err) {
    _readiness = {
      state: READINESS_STATE.FAULTED,
      reason: err.message,
      availableDevices: Array.from(_availableDevices),
      capabilities: [],
      models: [],
      openVinoVersion: _manager?._helper?.openVinoVersion || null,
      helperVersion: _manager?._helper?.helperVersion || null,
      probedAt: new Date().toISOString(),
      integrity: { ok: true, models: [], manifestMismatch: false },
    };
    return _readiness;
  }

  // 2. Probe each approved model against its certified device (no compile, no
  //    fallback).  Advertise only capability strings for the probed device.
  const capabilities = [];
  const models = [];
  let probeTimedOut = false;

  for (const model of listApprovedModels()) {
    if (_shutdownRequested) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { probeTimedOut = true; break; }

    const probe = await probeCapability(model.modelId, Math.min(remaining, 30000));
    if (probe.status !== "ready") continue;

    const probedDevice = probe.device;
    // Use the tier-aware capability strings from the manifest, which include
    // the certification tier suffix (e.g. :certified, :detected_self_tested).
    // This guarantees every advertised capability carries its tier.
    // Format: openvino.text_embedding:<model>:<device>:seq<N>:batch<N>:<tier>
    const modelCaps = getAdvertisedCapabilities(model.modelId, _availableDevices).filter((cap) => {
      const parts = String(cap).split(":");
      // After the tier suffix, there are now 6 parts. Device is at index 2.
      return parts.length >= 5 && parts[2] === probedDevice;
    });
    if (modelCaps.length === 0) continue;

    const tier = statusToTier(model.status);
    capabilities.push(...modelCaps);
    models.push({
      name: model.modelId,
      provider: "openvino",
      device: probedDevice,
      dimensions: model.outputDimensions,
      embeddingSpaceId: model.embeddingSpaceId,
      capabilities: modelCaps,
      certificationTier: tier,
    });
  }

  // 2b. Verify model file integrity against manifest hashes.
  let integrity = null;
  if (_config.modelsDir) {
    try {
      integrity = verifyModelIntegrity(_config.modelsDir);
    } catch (err) {
      integrity = { ok: false, models: [], manifestMismatch: true, error: err.message };
    }

    if (integrity && !integrity.ok && integrity.manifestMismatch) {
      _log("warn", "Model integrity hash mismatch detected; withdrawing affected capabilities", {
        models: integrity.models.filter((m) => !m.ok).map((m) => m.modelId),
      });

      // Collect model IDs with hash mismatches (not merely missing files).
      const failedModels = new Set(
        integrity.models.filter((m) => m.mismatches && m.mismatches.length > 0).map((m) => m.modelId)
      );

      // Remove capabilities for models that failed integrity checks.
      for (let i = capabilities.length - 1; i >= 0; i--) {
        const parts = capabilities[i].split(":");
        if (parts.length >= 2 && failedModels.has(parts[1])) {
          capabilities.splice(i, 1);
        }
      }

      // Remove models with integrity failures from the inventory.
      for (let i = models.length - 1; i >= 0; i--) {
        if (failedModels.has(models[i].name)) {
          models.splice(i, 1);
        }
      }
    } else if (integrity && !integrity.ok) {
      _log("info", "Model files not yet provisioned; integrity check deferred", {
        models: integrity.models.filter((m) => !m.ok).map((m) => m.modelId),
      });
    }
  }

  // 3. Decide the honest overall state.
  const devices = Array.from(_availableDevices);
  let state;
  let reason;
  if (capabilities.length > 0) {
    state = READINESS_STATE.READY;
    reason = `${capabilities.length} certified profile(s) ready across [${devices.join(", ")}]`;
  } else if (probeTimedOut) {
    state = READINESS_STATE.FAULTED;
    reason = "Readiness probing exceeded the startup deadline";
  } else {
    state = READINESS_STATE.UNAVAILABLE;
    reason = devices.length > 0
      ? `Helper ready on [${devices.join(", ")}] but no certified profile passed readiness`
      : "No OpenVINO devices were enumerated";
  }

  _readiness = {
    state,
    reason,
    availableDevices: devices,
    capabilities,
    models,
    openVinoVersion: _manager?._helper?.openVinoVersion || null,
    helperVersion: _manager?._helper?.helperVersion || null,
    probedAt: new Date().toISOString(),
    integrity: integrity || { ok: true, models: [], manifestMismatch: false },
  };
  _log("info", "OpenVINO startup readiness established", {
    state,
    devices,
    capabilities: capabilities.length,
    models: models.map((m) => m.name),
  });
  return _readiness;
}

// ---------------------------------------------------------------------------
// Result validation
// ---------------------------------------------------------------------------

/**
 * Validate the helper response before accepting it as a job result.
 *
 * @param {object} response  Helper response object.
 * @param {object} approvedModel  Model manifest entry.
 * @param {object} jobPayload  Original validated job payload.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateHelperResponse(response, approvedModel, jobPayload) {
  if (!response || typeof response !== "object") {
    return { valid: false, error: "Helper returned non-object response" };
  }
  if (response.ok !== true) {
    return {
      valid: false,
      error: `Helper returned error: [${response.error_code || "unknown"}] ${response.error || ""}`,
    };
  }

  // Verify action matches what was requested.
  if (response.action !== "embed") {
    return {
      valid: false,
      error: `Unexpected response action '${response.action}'; expected 'embed'`,
    };
  }

  // Verify model_id hasn't changed.
  if (response.model_id !== jobPayload.model_id) {
    return {
      valid: false,
      error: `Response model_id '${response.model_id}' does not match request '${jobPayload.model_id}'`,
    };
  }

  // Validate device provenance — detect silent fallback.
  const certifiedDevice = approvedModel.certifiedDevice;
  const jobFallback = jobPayload.fallback || "none";
  const responseFallbackOccurred = Boolean(response.fallback_occurred);
  const responseDevice = response.device;

  if (responseDevice !== certifiedDevice) {
    // A fallback occurred.  Only accept if fallback was explicitly authorized.
    if (jobFallback !== "same_model_cpu" || !approvedModel.fallbackDevice) {
      return {
        valid: false,
        error:
          `BACKEND MISMATCH: requested device '${certifiedDevice}' but ` +
          `helper ran on '${responseDevice}'.  Fallback not authorised ` +
          `(job.fallback='${jobFallback}').`,
      };
    }
    if (!responseFallbackOccurred) {
      return {
        valid: false,
        error:
          `Device mismatch: requested '${certifiedDevice}', got '${responseDevice}', ` +
          `but helper did not report fallback_occurred=true.`,
      };
    }
  }

  // Validate embedding is present and non-empty.
  const embedding = response.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return { valid: false, error: "Helper returned empty or missing embedding" };
  }

  // Validate embedding dimension.
  if (embedding.length !== approvedModel.outputDimensions) {
    return {
      valid: false,
      error:
        `Embedding dimension ${embedding.length} does not match expected ` +
        `${approvedModel.outputDimensions} for model '${jobPayload.model_id}'`,
    };
  }

  // Validate all values are finite.
  const hasNonFinite = embedding.some((v) => !Number.isFinite(v));
  if (hasNonFinite) {
    return { valid: false, error: "Embedding contains non-finite values" };
  }

  // Validate L2 norm is approximately 1.0 (normalised).
  const norm = Math.sqrt(embedding.reduce((acc, v) => acc + v * v, 0));
  if (!Number.isFinite(norm) || norm < MIN_EMBEDDING_NORM || norm > MAX_EMBEDDING_NORM) {
    return {
      valid: false,
      error: `Embedding L2 norm ${norm.toFixed(6)} outside expected range [${MIN_EMBEDDING_NORM}, ${MAX_EMBEDDING_NORM}]`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

/**
 * Execute an OpenVINO embedding job.
 *
 * This function is called by the executor-registry framework.
 *
 * @param {object} _context  Executor context (inference service etc.) — not used
 *                           here since we have our own helper.
 * @param {object} input     Validated job requestPayload.
 * @returns {Promise<object>} Embedding result with provenance metadata.
 */
async function executeOpenVinoEmbed(_context, input) {
  if (!_config || !_config.enabled) {
    throw Object.assign(
      new Error("OpenVINO executor is not enabled on this worker"),
      { helperErrorCode: "runtime_missing" }
    );
  }

  if (!_manager) {
    throw Object.assign(
      new Error("OpenVINO helper manager not initialised"),
      { helperErrorCode: "runtime_missing" }
    );
  }

  // --- Validate the job payload against the manifest ---
  const validationError = validateJobRequest(input, _config);
  if (validationError) {
    throw Object.assign(new Error(validationError), {
      helperErrorCode: "policy_denied",
    });
  }

  const approvedModel = getApprovedModel(input.model_id);
  if (!approvedModel) {
    throw Object.assign(
      new Error(`Model '${input.model_id}' not found in approved manifest`),
      { helperErrorCode: "unsupported_model" }
    );
  }

  // --- Determine effective fallback policy ---
  // Job may tighten but not loosen the worker-level policy.
  const workerFallbackPolicy = _config.fallbackPolicy;
  const jobFallback = input.fallback || "none";
  let effectiveFallback = "none";
  if (workerFallbackPolicy === "same_model_cpu" && jobFallback === "same_model_cpu") {
    effectiveFallback = "same_model_cpu";
  }

  // --- Build request for helper ---
  const helperRequest = {
    action: "embed",
    model_id: input.model_id,
    input_kind: input.input_kind,
    text: input.text,
    fallback: effectiveFallback,
  };

  const deadlineMs = _config.inferenceTimeoutMs;

  // --- Send to helper ---
  let response;
  try {
    response = await _manager.embed(helperRequest, deadlineMs);
  } catch (err) {
    const code = err.helperErrorCode || "inference_failed";
    throw Object.assign(
      new Error(`OpenVINO inference failed: ${err.message}`),
      { helperErrorCode: code }
    );
  }

  // --- Validate response ---
  const check = validateHelperResponse(response, approvedModel, {
    ...input,
    fallback: effectiveFallback,
  });
  if (!check.valid) {
    throw Object.assign(new Error(check.error), {
      helperErrorCode: "result_validation_failed",
    });
  }

  // --- Build structured result ---
  return {
    embedding: response.embedding,
    model_id: response.model_id,
    embedding_space_id: response.embedding_space_id || approvedModel.embeddingSpaceId,
    dimensions: response.dimensions || approvedModel.outputDimensions,
    device: response.device,
    requested_device: response.requested_device || approvedModel.certifiedDevice,
    fallback_occurred: Boolean(response.fallback_occurred),
    fallback_reason: response.fallback_reason || null,
    sequence_length: response.sequence_length,
    token_count: response.token_count,
    preprocess_ms: response.preprocess_ms,
    infer_ms: response.infer_ms,
    preprocessing_version: response.preprocessing_version,
    openvino_version: response.openvino_version,
    helper_version: response.helper_version,
    normalized: Boolean(response.normalized),
    executor_type: EXECUTOR_TYPE,
    executor_version: EXECUTOR_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Capability probe (non-blocking, no side effects)
// ---------------------------------------------------------------------------

/**
 * Return a detailed capability probe result.
 *
 * This is used by the worker's health and readiness endpoints.
 * It does NOT perform actual NPU inference.
 *
 * @param {string} modelId  Model to check.
 * @param {number} [timeoutMs]  Bound for the helper `ready` round-trip.
 * @returns {Promise<object>}
 */
async function probeCapability(modelId, timeoutMs = 30000) {
  if (!_config || !_config.enabled) {
    return {
      status: "disabled",
      reason: "Feature disabled",
      modelId,
    };
  }

  const approvedModel = getApprovedModel(modelId);
  if (!approvedModel) {
    return {
      status: "unsupported_model",
      reason: `Model '${modelId}' not in approved manifest`,
      modelId,
    };
  }

  if (!_manager) {
    return {
      status: "runtime_missing",
      reason: "Helper manager not initialised",
      modelId,
    };
  }

  try {
    const response = await _manager.checkReady(modelId, timeoutMs);
    const approvedModel = getApprovedModel(modelId);
    const certificationTier = approvedModel ? statusToTier(approvedModel.status) : CERTIFICATION_TIER.UNSUPPORTED;
    return {
      status: "ready",
      modelId,
      device: response.device,
      availableDevices: response.available_devices || [],
      openVinoVersion: response.openvino_version,
      helperVersion: response.helper_version,
      certifiedProfiles: response.certified_profiles || [],
      outputDimensions: response.output_dimensions,
      embeddingSpaceId: response.embedding_space_id,
      certificationTier,
    };
  } catch (err) {
    const code = err.helperErrorCode || "probe_failed";
    return {
      status: code,
      reason: err.message.slice(0, 500),
      modelId,
    };
  }
}

// ---------------------------------------------------------------------------
// On-demand integrity check
// ---------------------------------------------------------------------------

/**
 * Run an on-demand model integrity check against the manifest hashes.
 *
 * This can be called at any time (e.g. by the dashboard or an operator CLI)
 * without affecting the cached readiness snapshot.
 *
 * @returns {{ ok: boolean, models: object[], manifestMismatch: boolean }|null}
 *   null when OpenVINO is disabled or modelsDir is not configured.
 */
function checkModelIntegrity() {
  if (!_config || !_config.enabled || !_config.modelsDir) return null;
  try {
    return verifyModelIntegrity(_config.modelsDir);
  } catch (err) {
    return { ok: false, models: [], manifestMismatch: true, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Shut down the OpenVINO helper manager (kills the persistent Python helper
 * process and prevents further restarts).  Safe to call when the executor was
 * never initialised or is disabled.
 */
function shutdownOpenVinoExecutor() {
  _shutdownRequested = true;
  // Abort any in-flight startup-readiness wait so shutdown-during-init returns
  // promptly instead of blocking until the deadline.
  if (_readinessAbort) {
    try { _readinessAbort(); } catch { /* best effort */ }
  }
  // If readiness never completed, record an honest terminal snapshot.
  if (!_readiness || _readiness.state === READINESS_STATE.PROBING) {
    _readiness = {
      state: READINESS_STATE.FAULTED,
      reason: "shutdown requested during initialization",
      availableDevices: Array.from(_availableDevices),
      capabilities: [],
      models: [],
      openVinoVersion: null,
      helperVersion: null,
      probedAt: new Date().toISOString(),
      integrity: { ok: true, models: [], manifestMismatch: false },
    };
  }
  if (_manager) {
    try {
      _manager.shutdown();
    } catch (err) {
      _log("warn", "Error during OpenVINO executor shutdown", { error: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// Executor definition (for executor-registry registration)
// ---------------------------------------------------------------------------

const OPENVINO_EXECUTOR_DEFINITION = {
  type: EXECUTOR_TYPE,
  version: EXECUTOR_VERSION,
  description:
    "Intel OpenVINO NPU text embedding executor (E5-small-v2 CPU, Qwen3 NPU/CPU)",
  risk: "low",
  capabilities: ["embeddings", "text_embedding"],
  platforms: ["win32"],   // Certified for native Windows only per the ADR.
  inputSchema: {
    model_id: "string",
    input_kind: "string",
    text: "string",
    fallback: "string (optional)",
  },
  outputSchema: {
    embedding: "number[]",
    model_id: "string",
    embedding_space_id: "string",
    dimensions: "number",
    device: "string",
    requested_device: "string",
    fallback_occurred: "boolean",
    infer_ms: "number",
    normalized: "boolean",
  },
  resourceLimits: {
    maxConcurrent: 1,
    memoryBytes: 4 * 1024 * 1024 * 1024, // 3.1 GB for Qwen NPU + headroom
  },
  timeout: 120000,
  cancellation: true,
  maxInputSize: 64 * 1024,
  maxOutputSize: 1 * 1024 * 1024,
  dataClassifications: ["public", "internal", "private"],
  execute: executeOpenVinoEmbed,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  EXECUTOR_TYPE,
  EXECUTOR_VERSION,
  READINESS_STATE,
  OPENVINO_EXECUTOR_DEFINITION,
  initOpenVinoExecutor,
  awaitStartupReadiness,
  getStartupReadiness,
  executeOpenVinoEmbed,
  validateHelperResponse,
  getOpenVinoCapabilities,
  getCapabilityStatus,
  probeCapability,
  checkModelIntegrity,
  shutdownOpenVinoExecutor,
};
