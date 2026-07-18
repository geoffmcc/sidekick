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
 *   - Model file integrity is verified via SHA-256 at init.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Certification tier (explicit lifecycle states for runtime trust)
// ---------------------------------------------------------------------------

const CERTIFICATION_TIER = Object.freeze({
  CERTIFIED: "certified",
  DETECTED_SELF_TESTED: "detected_self_tested",
  UNSUPPORTED: "unsupported",
});

/**
 * Map a model entry's `status` string to a CERTIFICATION_TIER value.
 *
 * `certified`, `detected_self_tested`, and `unsupported` are the canonical
 * runtime tiers. Any unknown status defaults to `unsupported` — the caller
 * must not assume certification without an explicit tier.
 *
 * @param {string} status
 * @returns {string}
 */
function statusToTier(status) {
  if (status === CERTIFICATION_TIER.CERTIFIED) return CERTIFICATION_TIER.CERTIFIED;
  if (status === CERTIFICATION_TIER.DETECTED_SELF_TESTED) return CERTIFICATION_TIER.DETECTED_SELF_TESTED;
  if (status === CERTIFICATION_TIER.UNSUPPORTED) return CERTIFICATION_TIER.UNSUPPORTED;
  return CERTIFICATION_TIER.UNSUPPORTED; // Unknown => unsafe default.
}

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

    // SHA-256 integrity hashes for model config files (relative to model dir).
    // These cover the files that define model behaviour; weights are verified
    // by the Python helper's own integrity check at load time.
    integrity: Object.freeze({
      algorithm: "sha256",
      files: Object.freeze({
        "config.json": "placeholder_e5_config_sha256",
        "tokenizer.json": "placeholder_e5_tokenizer_sha256",
      }),
    }),

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

    // SHA-256 integrity hashes for model config files (relative to model dir).
    integrity: Object.freeze({
      algorithm: "sha256",
      files: Object.freeze({
        "config.json": "placeholder_qwen_config_sha256",
        "tokenizer.json": "placeholder_qwen_tokenizer_sha256",
      }),
    }),

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
 * Each returned capability string carries the model's certification tier as a
 * final segment so the scheduler can distinguish certified profiles from
 * self-tested or unsupported ones.
 *
 * Format: openvino.text_embedding:<model>:<device>:seq<N>:batch<N>:<tier>
 *
 * @param {string} modelId
 * @param {Set<string>} availableDevices
 * @returns {string[]}
 */
function getAdvertisedCapabilities(modelId, availableDevices) {
  const model = getApprovedModel(modelId);
  if (!model) return [];

  const tier = statusToTier(model.status);
  if (tier === CERTIFICATION_TIER.UNSUPPORTED) return [];

  return model.advertiseCapabilities.filter((cap) => {
    // Parse the device segment from the capability string.
    // Format: openvino.text_embedding:<model>:<device>:seq<N>:batch<N>
    const parts = cap.split(":");
    if (parts.length < 3) return false;
    const device = parts[2];
    return availableDevices.has(device);
  }).map((cap) => `${cap}:${tier}`);
}

// ---------------------------------------------------------------------------
// Model integrity verification
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of a file.
 *
 * @param {string} filePath  Absolute path to the file.
 * @returns {string}  Lowercase hex-encoded SHA-256 digest.
 */
function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Verify model file integrity against the manifest's expected hashes.
 *
 * For each approved model that declares integrity hashes, compute the
 * SHA-256 of each listed file (relative to `modelsDir/<modelId>/`) and
 * compare.  Returns a structured result per model.
 *
 * When a model directory does not exist or is missing files, the model is
 * reported as `ok: false` but `manifestMismatch` is only set to true when
 * a file exists but its hash does not match (indicating tampering vs. merely
 * not being provisioned yet).
 *
 * @param {string} modelsDir  Absolute path to the trusted model store root.
 * @returns {{ ok: boolean, models: object[], manifestMismatch: boolean }}
 *   ok is false if ANY model has a hash mismatch or is missing.  manifestMismatch
 *   is true only when at least one existing file did not match its hash.
 */
function verifyModelIntegrity(modelsDir) {
  const results = [];
  let allOk = true;
  let manifestMismatch = false;

  for (const model of APPROVED_MODELS) {
    if (!model.integrity || !model.integrity.files) {
      results.push({
        modelId: model.modelId,
        ok: true,
        reason: "no integrity hashes declared (skipped)",
        checked: 0,
        matched: 0,
      });
      continue;
    }

    const modelDir = path.join(modelsDir, model.modelId);
    let checked = 0;
    let matched = 0;
    const mismatches = [];
    const missing = [];

    for (const [relPath, expectedHash] of Object.entries(model.integrity.files)) {
      const filePath = path.join(modelDir, relPath);
      checked++;

      if (!fs.existsSync(filePath)) {
        missing.push(relPath);
        continue;
      }

      try {
        const actualHash = sha256File(filePath);
        if (actualHash === expectedHash) {
          matched++;
        } else {
          mismatches.push(relPath);
        }
      } catch {
        mismatches.push(relPath);
      }
    }

    const modelOk = mismatches.length === 0 && missing.length === 0;
    if (!modelOk) allOk = false;
    if (mismatches.length > 0) manifestMismatch = true;

    results.push({
      modelId: model.modelId,
      ok: modelOk,
      reason: modelOk
        ? "all files verified"
        : `mismatch: ${mismatches.join(", ")}; missing: ${missing.join(", ")}`.trim(),
      checked,
      matched,
      mismatches,
      missing,
    });
  }

  return { ok: allOk, models: results, manifestMismatch };
}

/**
 * Verify integrity for a single model.
 *
 * @param {string} modelId
 * @param {string} modelsDir  Absolute path to the trusted model store root.
 * @returns {{ ok: boolean, reason: string, checked: number, matched: number,
 *   mismatches: string[], missing: string[] }}
 */
function verifyModelFileHash(modelId, modelsDir) {
  const model = getApprovedModel(modelId);
  if (!model) {
    return { ok: false, reason: `Model '${modelId}' not in approved manifest`, checked: 0, matched: 0, mismatches: [], missing: [] };
  }
  if (!model.integrity || !model.integrity.files) {
    return { ok: true, reason: "no integrity hashes declared", checked: 0, matched: 0, mismatches: [], missing: [] };
  }

  const modelDir = path.join(modelsDir, modelId);
  let checked = 0;
  let matched = 0;
  const mismatches = [];
  const missing = [];

  for (const [relPath, expectedHash] of Object.entries(model.integrity.files)) {
    const filePath = path.join(modelDir, relPath);
    checked++;

    if (!fs.existsSync(filePath)) {
      missing.push(relPath);
      continue;
    }

    try {
      const actualHash = sha256File(filePath);
      if (actualHash === expectedHash) {
        matched++;
      } else {
        mismatches.push(relPath);
      }
    } catch {
      mismatches.push(relPath);
    }
  }

  const ok = mismatches.length === 0 && missing.length === 0;
  return {
    ok,
    reason: ok
      ? "all files verified"
      : `mismatch: ${mismatches.join(", ")}; missing: ${missing.join(", ")}`.trim(),
    checked,
    matched,
    mismatches,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  APPROVED_MODELS,
  INPUT_KIND,
  FALLBACK_POLICY,
  DEVICE,
  CERTIFICATION_TIER,
  statusToTier,
  getApprovedModel,
  listApprovedModels,
  isDeniedCombination,
  validateJobRequest,
  getAdvertisedCapabilities,
  verifyModelIntegrity,
  verifyModelFileHash,
  sha256File,
};
