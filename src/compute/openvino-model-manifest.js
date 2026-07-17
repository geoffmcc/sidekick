"use strict";

/**
 * OpenVINO Approved Model Manifest
 *
 * This is the authoritative server-controlled allowlist for models that may
 * execute through the OpenVINO helper.  Jobs may only request models and
 * parameters defined here.
 *
 * Security properties:
 *   - Model IDs are compared literally; no pattern matching.
 *   - Caller-supplied filesystem paths are never accepted.
 *   - Caller-supplied device strings are never accepted.
 *   - Caller-supplied tensor shapes are never accepted.
 *   - Caller-supplied fallback values may only tighten, not loosen, policy.
 *   - CLAP audio on NPU is permanently denied per the ADR.
 */

"use strict";

// ---------------------------------------------------------------------------
// Model profile constants
// ---------------------------------------------------------------------------

const INPUT_KIND = Object.freeze({
  QUERY: "query",
  DOCUMENT: "document",
});

const FALLBACK_POLICY = Object.freeze({
  NONE: "none",
  SAME_MODEL_CPU: "same_model_cpu",
});

const DEVICE = Object.freeze({
  CPU: "CPU",
  NPU: "NPU",
  GPU: "GPU",
});

// ---------------------------------------------------------------------------
// Approved model catalogue
// Each entry is an immutable, explicitly typed record.
// ---------------------------------------------------------------------------

const APPROVED_MODELS = Object.freeze([
  Object.freeze({
    // -----------------------------------------------------------------------
    // E5-small-v2 qINT8 — CPU only (certified; NPU rejected as slower)
    // -----------------------------------------------------------------------
    modelId: "e5-small-v2-qint8",
    displayName: "E5-small-v2 INT8",
    embeddingSpaceId: "e5-small-v2",
    outputDimensions: 384,

    // Certified hardware.
    certifiedDevice: DEVICE.CPU,
    fallbackDevice: null,               // No fallback. CPU IS the primary.
    defaultFallbackPolicy: FALLBACK_POLICY.NONE,

    // Certified static shapes.
    certifiedSequenceLengths: Object.freeze([512]),
    maxSequenceLength: 512,
    batchSize: 1,

    // Preprocessing (for documentation; enforced in helper.py).
    preprocessing: Object.freeze({
      version: "1",
      queryPrefix: "query: ",
      documentPrefix: "passage: ",
      paddingStrategy: "right",
      pooling: "mean",
      normalization: "L2",
      truncation: false,           // Reject rather than silently truncate.
    }),

    // Capability advertisement.
    advertiseCapabilities: Object.freeze([
      "openvino.text_embedding:e5-small-v2-qint8:CPU:seq512:batch1",
    ]),

    // ADR task type.
    taskType: "text_embedding",

    // Lifecycle.
    status: "certified",

    // CLAP audio on NPU: permanently denied. Not applicable to this model.
    clapAudioNpuDenied: false,
  }),

  Object.freeze({
    // -----------------------------------------------------------------------
    // Qwen3-Embedding-0.6B INT8 — NPU primary, CPU fallback optional
    // -----------------------------------------------------------------------
    modelId: "qwen3-embedding-0.6b-int8",
    displayName: "Qwen3-Embedding-0.6B INT8",
    embeddingSpaceId: "qwen3-embedding-0.6b",
    outputDimensions: 1024,

    // Certified hardware.
    certifiedDevice: DEVICE.NPU,
    fallbackDevice: DEVICE.CPU,         // Same model, same manifest, same space.
    defaultFallbackPolicy: FALLBACK_POLICY.SAME_MODEL_CPU,   // Worker admin enables.

    // Certified static shapes (128 and 512).
    certifiedSequenceLengths: Object.freeze([128, 512]),
    maxSequenceLength: 512,
    batchSize: 1,

    // Preprocessing.
    preprocessing: Object.freeze({
      version: "1",
      // Certified query instruction (matches helper.py QWEN_TASK_INSTRUCTION and
      // the accepted real-text correctness spike). Documentation only; the
      // authoritative preprocessing is enforced in helper.py.
      taskInstruction:
        "Instruct: Given a user query, retrieve the most relevant passage that " +
        "answers the query or contains the needed technical information\nQuery:",
      queryInstruction: true,
      documentInstruction: false,
      paddingStrategy: "left",
      pooling: "last_token",
      normalization: "L2",
      truncation: false,
      trustRemoteCode: false,
    }),

    // Capability advertisement (both profiles × both certified devices).
    advertiseCapabilities: Object.freeze([
      "openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq128:batch1",
      "openvino.text_embedding:qwen3-embedding-0.6b-int8:NPU:seq512:batch1",
      "openvino.text_embedding:qwen3-embedding-0.6b-int8:CPU:seq128:batch1",
      "openvino.text_embedding:qwen3-embedding-0.6b-int8:CPU:seq512:batch1",
    ]),

    taskType: "text_embedding",
    status: "certified",
    clapAudioNpuDenied: false,
  }),
]);

// ---------------------------------------------------------------------------
// Forbidden model/device combinations (enforced before helper execution)
// ---------------------------------------------------------------------------

const PERMANENTLY_DENIED_COMBINATIONS = Object.freeze([
  // CLAP audio on NPU — permanently denied by ADR evidence.
  Object.freeze({ modelPattern: "clap", device: DEVICE.NPU, reason: "CLAP audio NPU accuracy rejected by ADR (cosine ~0.59)" }),
  // E5 on NPU — rejected as slower, certified CPU only.
  Object.freeze({ modelId: "e5-small-v2-qint8", device: DEVICE.NPU, reason: "E5 CPU is materially faster; NPU rejected for this model" }),
]);

// ---------------------------------------------------------------------------
// Index for fast lookup
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const MODEL_INDEX = new Map(
  APPROVED_MODELS.map((m) => [m.modelId, m])
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up an approved model by ID.
 *
 * @param {string} modelId
 * @returns {object|null}
 */
function getApprovedModel(modelId) {
  if (typeof modelId !== "string") return null;
  return MODEL_INDEX.get(modelId) || null;
}

/**
 * Return all approved models (read-only).
 *
 * @returns {readonly object[]}
 */
function listApprovedModels() {
  return APPROVED_MODELS;
}

/**
 * Check whether a model/device combination is permanently denied.
 *
 * @param {string} modelId
 * @param {string} device  e.g. "NPU", "CPU"
 * @returns {{ denied: boolean, reason?: string }}
 */
function isDeniedCombination(modelId, device) {
  for (const rule of PERMANENTLY_DENIED_COMBINATIONS) {
    if (rule.modelId && rule.modelId !== modelId) continue;
    if (rule.modelPattern && !String(modelId).includes(rule.modelPattern)) continue;
    if (rule.device !== device) continue;
    return { denied: true, reason: rule.reason };
  }
  return { denied: false };
}

/**
 * Validate a job request payload against the manifest.
 *
 * Returns null if valid, or a string describing the first violation.
 *
 * Enforced rules:
 *   - model_id must be in the approved catalogue.
 *   - input_kind must be "query" or "document".
 *   - fallback value must not loosen the model's default policy.
 *   - Forbidden model/device pairs are rejected unconditionally.
 *   - No arbitrary fields with security implications are accepted.
 *
 * @param {object} jobPayload  Trusted (server-validated) job request payload.
 * @param {object} workerConfig  Loaded OpenVINO config.
 * @returns {string|null}  Null if valid, error string if rejected.
 */
function validateJobRequest(jobPayload, workerConfig) {
  if (!jobPayload || typeof jobPayload !== "object") {
    return "Missing job payload";
  }

  // --- Reject forbidden fields ---
  const FORBIDDEN_FIELDS = [
    "model_path",
    "model_url",
    "device",
    "device_string",
    "shell",
    "command",
    "argv",
    "executable",
    "env",
    "environment",
    "python_path",
    "helper_path",
    "cache_dir",
    "state_dir",
    "sequence_length",
    "batch_size",
    "options",
    "trust_remote_code",
  ];
  for (const field of FORBIDDEN_FIELDS) {
    if (field in jobPayload) {
      return `Job payload contains forbidden field '${field}'. The worker controls this parameter.`;
    }
  }

  // --- model_id ---
  const modelId = jobPayload.model_id;
  if (!modelId || typeof modelId !== "string") {
    return "Job payload missing required string field 'model_id'";
  }
  if (modelId.length > 128) {
    return `model_id exceeds maximum length`;
  }
  if (modelId.includes("\0") || modelId.includes("..") || modelId.includes("/") || modelId.includes("\\")) {
    return `model_id contains invalid characters`;
  }

  const model = getApprovedModel(modelId);
  if (!model) {
    return `Model '${modelId}' is not in the approved model catalogue`;
  }
  if (model.status !== "certified") {
    return `Model '${modelId}' has lifecycle status '${model.status}' and is not currently certified`;
  }

  // --- input_kind ---
  const inputKind = jobPayload.input_kind;
  if (!inputKind || typeof inputKind !== "string") {
    return "Job payload missing required field 'input_kind' (must be 'query' or 'document')";
  }
  if (!["query", "document"].includes(inputKind)) {
    return `Invalid input_kind '${inputKind}'. Must be 'query' or 'document'.`;
  }

  // --- text ---
  const text = jobPayload.text;
  if (typeof text !== "string") {
    return "Job payload missing required string field 'text'";
  }
  if (text.length === 0) {
    return "Field 'text' must not be empty";
  }
  const maxInputChars = (workerConfig && workerConfig.maxInputChars) || 32768;
  if (text.length > maxInputChars) {
    return `Field 'text' exceeds maximum length ${maxInputChars}`;
  }
  if (text.includes("\0")) {
    return "Field 'text' contains a null byte";
  }

  // --- fallback ---
  if ("fallback" in jobPayload) {
    const fallback = jobPayload.fallback;
    if (typeof fallback !== "string") {
      return "Field 'fallback' must be a string";
    }
    if (!["none", "same_model_cpu"].includes(fallback)) {
      return `Invalid fallback value '${fallback}'. Must be 'none' or 'same_model_cpu'.`;
    }
    // A job may only tighten, not loosen, the model's default policy.
    const modelDefault = model.defaultFallbackPolicy;
    if (modelDefault === "none" && fallback !== "none") {
      return `Model '${modelId}' does not permit fallback; job may not set fallback='${fallback}'`;
    }
    // Additionally validate against worker-level policy.
    if (workerConfig && workerConfig.fallbackPolicy === "none" && fallback !== "none") {
      return `Worker fallback policy is 'none'; job may not set fallback='${fallback}'`;
    }
  }

  // --- Check permanently denied combinations ---
  const certifiedDevice = model.certifiedDevice;
  const check = isDeniedCombination(modelId, certifiedDevice);
  if (check.denied) {
    return `Model '${modelId}' on device '${certifiedDevice}' is permanently denied: ${check.reason}`;
  }

  return null; // Valid
}

/**
 * Collect the capability strings that should be advertised for a model when
 * the given device is available and the model certification is ready.
 *
 * @param {string} modelId
 * @param {Set<string>} availableDevices
 * @returns {string[]}
 */
function getAdvertisedCapabilities(modelId, availableDevices) {
  const model = getApprovedModel(modelId);
  if (!model || model.status !== "certified") return [];

  return model.advertiseCapabilities.filter((cap) => {
    // Parse the device segment from the capability string.
    // Format: openvino.text_embedding:<model>:<device>:seq<N>:batch<N>
    const parts = cap.split(":");
    if (parts.length < 3) return false;
    const device = parts[2];
    return availableDevices.has(device);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  APPROVED_MODELS,
  INPUT_KIND,
  FALLBACK_POLICY,
  DEVICE,
  getApprovedModel,
  listApprovedModels,
  isDeniedCombination,
  validateJobRequest,
  getAdvertisedCapabilities,
};
