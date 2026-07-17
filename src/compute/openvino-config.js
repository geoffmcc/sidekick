"use strict";

/**
 * OpenVINO NPU Executor — Configuration Loader
 *
 * Reads, validates, and normalises configuration from environment variables.
 * All security-sensitive defaults are conservative (feature disabled, no fallback,
 * minimum timeouts, single concurrency).
 *
 * Call loadOpenVinoConfig() once at worker startup and pass the result to
 * OpenVinoHelperManager. Do not re-read the environment mid-execution.
 */

const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HELPER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "1";

const ALLOWED_FALLBACK_POLICIES = Object.freeze(["none", "same_model_cpu"]);
const ALLOWED_LOG_LEVELS = Object.freeze(["error", "warn", "info", "debug"]);

const DEFAULT_WINDOWS_MODELS_DIR =
  process.platform === "win32"
    ? "C:\\ProgramData\\Sidekick\\openvino-models"
    : "/var/lib/sidekick/openvino-models";

const DEFAULT_WINDOWS_CACHE_DIR =
  process.platform === "win32"
    ? "C:\\ProgramData\\Sidekick\\openvino-cache"
    : "/var/lib/sidekick/openvino-cache";

const DEFAULT_WINDOWS_STATE_DIR =
  process.platform === "win32"
    ? "C:\\ProgramData\\Sidekick\\openvino-state"
    : "/var/lib/sidekick/openvino-state";

// ---------------------------------------------------------------------------
// Integer bounding helper
// ---------------------------------------------------------------------------

function boundedInt(rawValue, fallback, min, max) {
  const parsed = parseInt(rawValue || String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Reject paths that contain traversal attempts, null bytes, or UNC prefixes.
 * This validates the configured string before it is ever used.
 *
 * @param {string} rawPath
 * @param {string} label
 * @returns {string} The validated path string (not yet resolved).
 */
function validateConfigPath(rawPath, label) {
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error(`${label}: path must be a non-empty string`);
  }
  if (rawPath.includes("\0")) {
    throw new Error(`${label}: path contains a null byte`);
  }
  // Reject UNC paths (\\server\share or //server/share).
  if (/^[/\\]{2}/.test(rawPath)) {
    throw new Error(`${label}: UNC/network paths are not allowed`);
  }
  // Reject URL-like schemes.
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(rawPath)) {
    throw new Error(`${label}: URL paths are not allowed`);
  }
  // Reject obvious traversal sequences.
  if (rawPath.includes("..")) {
    throw new Error(`${label}: path must not contain '..' traversal components`);
  }
  // Reject alternate data streams on Windows (colons other than drive letter).
  if (process.platform === "win32") {
    const stripped = rawPath.replace(/^[A-Za-z]:/, "");
    if (stripped.includes(":")) {
      throw new Error(`${label}: alternate data stream paths are not allowed`);
    }
  }
  return rawPath;
}

/**
 * Validate that a resolved path is genuinely inside a known base directory.
 *
 * @param {string} resolvedPath
 * @param {string} resolvedBase
 * @param {string} label
 */
function assertPathInside(resolvedPath, resolvedBase, label) {
  const rel = path.relative(resolvedBase, resolvedPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `${label}: resolved path '${resolvedPath}' escapes base '${resolvedBase}'`
    );
  }
}

// ---------------------------------------------------------------------------
// Python executable validation
// ---------------------------------------------------------------------------

/**
 * Validate a Python executable path.
 *
 * The ADR requires the helper to be launched from a fixed absolute path owned
 * by the installer.  We accept an absolute path only.  We do NOT accept:
 *   - relative paths (PATH lookup)
 *   - "python" or "python3" (shell search)
 *   - any path containing traversal or null bytes
 *
 * @param {string} rawPath
 * @returns {string}
 */
function validatePythonPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error(
      "SIDEKICK_OPENVINO_PYTHON: Python executable path must be set to an absolute path. " +
        "Do not rely on PATH lookup."
    );
  }
  validateConfigPath(rawPath, "SIDEKICK_OPENVINO_PYTHON");
  if (!path.isAbsolute(rawPath)) {
    throw new Error(
      `SIDEKICK_OPENVINO_PYTHON: '${rawPath}' is not an absolute path. ` +
        "Specify the full installer-owned Python executable path."
    );
  }
  return rawPath;
}

// ---------------------------------------------------------------------------
// Main config loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the OpenVINO executor configuration.
 *
 * Throws an Error with an actionable message if any security-critical value
 * is invalid.
 *
 * @returns {OpenVinoConfig}
 */
function loadOpenVinoConfig() {
  const enabled = process.env.SIDEKICK_OPENVINO_ENABLED === "true";

  // If the feature is disabled, return a minimal config so callers can
  // gate on config.enabled without needing full validation.
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      pythonPath: null,
      modelsDir: null,
      cacheDir: null,
      stateDir: null,
      helperScript: null,
      startupTimeoutMs: 60000,
      inferenceTimeoutMs: 120000,
      maxInputChars: 32768,
      maxOutputDimensions: 1024,
      maxConcurrentInferences: 1,
      maxHelperRestarts: 3,
      helperRestartCooldownMs: 5000,
      fallbackPolicy: "none",
      logLevel: "info",
      diagnosticMode: false,
      protocolVersion: PROTOCOL_VERSION,
      helperVersion: HELPER_VERSION,
    });
  }

  // ------------------------------------------------------------------
  // Python executable
  // ------------------------------------------------------------------
  const pythonPath = validatePythonPath(
    process.env.SIDEKICK_OPENVINO_PYTHON || ""
  );

  // ------------------------------------------------------------------
  // Model store directory (read-only for worker/helper)
  // ------------------------------------------------------------------
  const rawModelsDir =
    process.env.SIDEKICK_OPENVINO_MODELS_DIR || DEFAULT_WINDOWS_MODELS_DIR;
  validateConfigPath(rawModelsDir, "SIDEKICK_OPENVINO_MODELS_DIR");

  // ------------------------------------------------------------------
  // Cache and state directories (writable)
  // ------------------------------------------------------------------
  const rawCacheDir =
    process.env.SIDEKICK_OPENVINO_CACHE_DIR || DEFAULT_WINDOWS_CACHE_DIR;
  validateConfigPath(rawCacheDir, "SIDEKICK_OPENVINO_CACHE_DIR");

  const rawStateDir =
    process.env.SIDEKICK_OPENVINO_STATE_DIR || DEFAULT_WINDOWS_STATE_DIR;
  validateConfigPath(rawStateDir, "SIDEKICK_OPENVINO_STATE_DIR");

  // ------------------------------------------------------------------
  // Helper script path (absolute, inside the package)
  // ------------------------------------------------------------------
  const defaultHelperScript = path.join(
    __dirname,
    "openvino",
    "helper.py"
  );
  const rawHelperScript =
    process.env.SIDEKICK_OPENVINO_HELPER_SCRIPT || defaultHelperScript;
  validateConfigPath(rawHelperScript, "SIDEKICK_OPENVINO_HELPER_SCRIPT");
  if (!path.isAbsolute(rawHelperScript)) {
    throw new Error(
      `SIDEKICK_OPENVINO_HELPER_SCRIPT must be an absolute path, got '${rawHelperScript}'`
    );
  }

  // ------------------------------------------------------------------
  // Timeouts (bounded strictly)
  // ------------------------------------------------------------------
  const startupTimeoutMs = boundedInt(
    process.env.SIDEKICK_OPENVINO_STARTUP_TIMEOUT_MS,
    60000,
    5000,
    300000
  );
  const inferenceTimeoutMs = boundedInt(
    process.env.SIDEKICK_OPENVINO_INFERENCE_TIMEOUT_MS,
    120000,
    5000,
    600000
  );

  // ------------------------------------------------------------------
  // Resource limits
  // ------------------------------------------------------------------
  const maxInputChars = boundedInt(
    process.env.SIDEKICK_OPENVINO_MAX_INPUT_CHARS,
    32768,
    1,
    131072
  );
  const maxOutputDimensions = boundedInt(
    process.env.SIDEKICK_OPENVINO_MAX_OUTPUT_DIMENSIONS,
    1024,
    1,
    8192
  );
  // The ADR mandates one concurrent inference per helper unless certified.
  const maxConcurrentInferences = boundedInt(
    process.env.SIDEKICK_OPENVINO_MAX_CONCURRENT,
    1,
    1,
    1  // Hard-capped at 1 until higher concurrency is separately certified.
  );
  const maxHelperRestarts = boundedInt(
    process.env.SIDEKICK_OPENVINO_MAX_RESTARTS,
    3,
    0,
    10
  );
  const helperRestartCooldownMs = boundedInt(
    process.env.SIDEKICK_OPENVINO_RESTART_COOLDOWN_MS,
    5000,
    1000,
    60000
  );

  // ------------------------------------------------------------------
  // Fallback policy
  // ------------------------------------------------------------------
  const rawFallback = (
    process.env.SIDEKICK_OPENVINO_FALLBACK_POLICY || "none"
  ).toLowerCase();
  if (!ALLOWED_FALLBACK_POLICIES.includes(rawFallback)) {
    throw new Error(
      `SIDEKICK_OPENVINO_FALLBACK_POLICY: '${rawFallback}' is not valid. ` +
        `Allowed values: ${ALLOWED_FALLBACK_POLICIES.join(", ")}`
    );
  }

  // ------------------------------------------------------------------
  // Log level
  // ------------------------------------------------------------------
  const rawLogLevel = (
    process.env.SIDEKICK_OPENVINO_LOG_LEVEL || "info"
  ).toLowerCase();
  if (!ALLOWED_LOG_LEVELS.includes(rawLogLevel)) {
    throw new Error(
      `SIDEKICK_OPENVINO_LOG_LEVEL: '${rawLogLevel}' is not valid. ` +
        `Allowed values: ${ALLOWED_LOG_LEVELS.join(", ")}`
    );
  }

  const diagnosticMode =
    process.env.SIDEKICK_OPENVINO_DIAGNOSTIC_MODE === "true";

  return Object.freeze({
    enabled: true,
    pythonPath,
    modelsDir: rawModelsDir,
    cacheDir: rawCacheDir,
    stateDir: rawStateDir,
    helperScript: rawHelperScript,
    startupTimeoutMs,
    inferenceTimeoutMs,
    maxInputChars,
    maxOutputDimensions,
    maxConcurrentInferences,
    maxHelperRestarts,
    helperRestartCooldownMs,
    fallbackPolicy: rawFallback,
    logLevel: rawLogLevel,
    diagnosticMode,
    protocolVersion: PROTOCOL_VERSION,
    helperVersion: HELPER_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadOpenVinoConfig,
  validateConfigPath,
  validatePythonPath,
  assertPathInside,
  boundedInt,
  ALLOWED_FALLBACK_POLICIES,
  PROTOCOL_VERSION,
  HELPER_VERSION,
};
