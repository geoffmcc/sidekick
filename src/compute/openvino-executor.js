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
} = require("./openvino-model-manifest");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXECUTOR_TYPE = "openvino.text_embedding";
const EXECUTOR_VERSION = "1";

// Minimum allowed embedding norm (reject near-zero / degenerate embeddings).
const MIN_EMBEDDING_NORM = 0.99;
const MAX_EMBEDDING_NORM = 1.01;

// ---------------------------------------------------------------------------
// Module-level state (one manager per executor instance)
// ---------------------------------------------------------------------------

let _config = null;
let _manager = null;
let _initError = null;
let _availableDevices = new Set();

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
 * @returns {Promise<object>}
 */
async function probeCapability(modelId) {
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
    const response = await _manager.checkReady(modelId, 30000);
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
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Shut down the OpenVINO helper manager (kills the persistent Python helper
 * process and prevents further restarts).  Safe to call when the executor was
 * never initialised or is disabled.
 */
function shutdownOpenVinoExecutor() {
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
  OPENVINO_EXECUTOR_DEFINITION,
  initOpenVinoExecutor,
  executeOpenVinoEmbed,
  validateHelperResponse,
  getOpenVinoCapabilities,
  getCapabilityStatus,
  probeCapability,
  shutdownOpenVinoExecutor,
};
