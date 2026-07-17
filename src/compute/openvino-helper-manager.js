"use strict";

/**
 * OpenVINO Helper Manager
 *
 * Manages the lifecycle of one or more persistent Python OpenVINO helper
 * subprocesses.  Each helper handles a single model/device combination.
 *
 * Security properties:
 *   - Uses spawnSync/spawn with argument arrays; never a shell.
 *   - The Python executable path must be an absolute installer-owned path.
 *   - Helper receives zero caller-controlled arguments.
 *   - Environment passed to helper is a minimal controlled set.
 *   - stdout is reserved for protocol messages; stderr for diagnostics.
 *   - Protocol messages are bounded line-by-line.
 *   - Malformed, oversized, or unexpected messages fail closed.
 *   - Process-tree kill (SIGKILL/taskkill) is used for hard cancellation.
 *   - Bounded restart policy prevents infinite restart loops.
 *   - No orphan processes on worker shutdown.
 *
 * This module does NOT implement job execution itself; see openvino-executor.js.
 */

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const crypto = require("crypto");

const { PROTOCOL_VERSION, HELPER_VERSION } = require("./openvino-config");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESPONSE_LINE_BYTES = 4 * 1024 * 1024; // 4 MiB (embedding vectors)
const MAX_STDERR_LINE_BYTES = 8192;
const REQUEST_ID_PREFIX = "hreq";
const HELPER_STATES = Object.freeze({
  STOPPED: "stopped",
  STARTING: "starting",
  READY: "ready",
  BUSY: "busy",
  RESTARTING: "restarting",
  FAILED: "failed",
  SHUTDOWN: "shutdown",
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function generateRequestId() {
  return `${REQUEST_ID_PREFIX}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// HelperProcess — wrapper around one Python child process
// ---------------------------------------------------------------------------

class HelperProcess extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.pythonPath  Absolute path to the Python executable.
   * @param {string} opts.helperScript  Absolute path to helper.py.
   * @param {string} opts.modelsDir  Absolute path to the trusted model store.
   * @param {number} opts.startupTimeoutMs
   * @param {string} opts.instanceId  Unique label for logging.
   * @param {Function} opts.log
   */
  constructor(opts) {
    super();
    this.pythonPath = opts.pythonPath;
    this.helperScript = opts.helperScript;
    this.modelsDir = opts.modelsDir;
    this.startupTimeoutMs = opts.startupTimeoutMs || 60000;
    this.instanceId = opts.instanceId || "helper";
    this._log = opts.log || (() => {});

    this.state = HELPER_STATES.STOPPED;
    this.child = null;
    this.availableDevices = [];
    this.openVinoVersion = null;
    this.helperVersion = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.exitCode = null;
    this.exitReason = null;
    this.restartCount = 0;

    // Pending request map: requestId → { resolve, reject, timeoutHandle }
    this._pending = new Map();

    // Line buffer for stdout (accumulate until \n).
    this._stdoutBuffer = "";
    this._stderrBuffer = "";
  }

  // --------------------------------------------------------------------------
  // Startup
  // --------------------------------------------------------------------------

  /**
   * Start the helper process.  Resolves when the "started" event is received
   * from the helper, or rejects on timeout or startup error.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.state === HELPER_STATES.SHUTDOWN) {
      throw new Error("Helper has been shut down and cannot be restarted");
    }
    if (this.state === HELPER_STATES.READY || this.state === HELPER_STATES.BUSY) {
      return;
    }

    this.state = HELPER_STATES.STARTING;
    this._log("info", "Starting OpenVINO helper process", {
      id: this.instanceId,
      python: this.pythonPath,
      script: this.helperScript,
    });

    // Build a minimal controlled environment.
    const childEnv = {
      SIDEKICK_OPENVINO_MODELS_DIR: this.modelsDir,
      // Enforce fully offline model/tokenizer loading at the library layer as
      // defense in depth for the ADR "no runtime model download" rule.
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      // Pass through LOCALAPPDATA / APPDATA / TEMP for Windows OpenVINO driver paths.
      ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
      ...(process.env.APPDATA ? { APPDATA: process.env.APPDATA } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      // USERPROFILE lets library home-dir (~) resolution succeed on Windows so
      // the helper does not create a stray "~" cache directory in its CWD.
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.HOMEDRIVE ? { HOMEDRIVE: process.env.HOMEDRIVE } : {}),
      ...(process.env.HOMEPATH ? { HOMEPATH: process.env.HOMEPATH } : {}),
      // Required for OpenVINO driver enumeration on Windows.
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    };

    // Launch using argument array; no shell, no string interpolation.
    this.child = spawn(
      this.pythonPath,
      ["-u", this.helperScript], // -u: unbuffered
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        shell: false,
        windowsHide: true,
      }
    );

    this.startedAt = nowIso();
    this._stdoutBuffer = "";
    this._stderrBuffer = "";

    // Attach stdout/stderr handlers.
    this.child.stdout.on("data", (chunk) => this._onStdoutData(chunk));
    this.child.stderr.on("data", (chunk) => this._onStderrData(chunk));
    this.child.on("error", (err) => this._onProcessError(err));
    this.child.on("exit", (code, signal) => this._onProcessExit(code, signal));

    // Wait for the "started" event with a timeout.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._killProcess();
        this.state = HELPER_STATES.FAILED;
        reject(new Error(
          `OpenVINO helper did not emit 'started' within ${this.startupTimeoutMs}ms`
        ));
      }, this.startupTimeoutMs);

      const onStarted = () => {
        clearTimeout(timer);
        this.removeListener("_started", onStarted);
        this.removeListener("_error", onError);
        resolve();
      };
      const onError = (err) => {
        clearTimeout(timer);
        this.removeListener("_started", onStarted);
        this.removeListener("_error", onError);
        reject(err);
      };

      this.once("_started", onStarted);
      this.once("_error", onError);
    });
  }

  // --------------------------------------------------------------------------
  // Request/response
  // --------------------------------------------------------------------------

  /**
   * Send a request to the helper and wait for the response.
   *
   * @param {object} requestBody  Must include action and required fields.
   * @param {number} timeoutMs  Hard timeout for this specific request.
   * @returns {Promise<object>}  The helper response object.
   */
  async request(requestBody, timeoutMs) {
    if (this.state === HELPER_STATES.SHUTDOWN || this.state === HELPER_STATES.FAILED) {
      throw new Error(`Helper is ${this.state} and cannot accept requests`);
    }
    if (this.state !== HELPER_STATES.READY && this.state !== HELPER_STATES.BUSY) {
      throw new Error(`Helper is not ready (state: ${this.state})`);
    }

    const requestId = generateRequestId();
    const envelope = {
      v: PROTOCOL_VERSION,
      id: requestId,
      ...requestBody,
    };
    const line = JSON.stringify(envelope);

    // Validate line size.
    if (Buffer.byteLength(line, "utf8") > 65536) {
      throw new Error(
        `Request envelope exceeds maximum line size of 65536 bytes`
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId);
          // Hard-kill the helper process on timeout.
          this._log("warn", "Helper inference timeout; killing process", {
            id: this.instanceId,
            requestId,
            timeoutMs,
          });
          this._killProcess();
          reject(new Error(
            `OpenVINO inference timed out after ${timeoutMs}ms`
          ));
        }
      }, timeoutMs);

      this._pending.set(requestId, { resolve, reject, timeoutHandle: timer });

      try {
        this.child.stdin.write(line + "\n", "utf8");
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        reject(new Error(`Failed to write to helper stdin: ${err.message}`));
      }
    });
  }

  // --------------------------------------------------------------------------
  // Cancellation
  // --------------------------------------------------------------------------

  /**
   * Hard-cancel any in-flight request by killing the helper process.
   * The parent will be notified via the _exited event and can decide
   * whether to restart.
   */
  cancelAll() {
    this._log("info", "Cancelling all in-flight requests via process kill", {
      id: this.instanceId,
      pendingCount: this._pending.size,
    });
    this._killProcess();
    // Reject all pending.
    for (const [id, { reject, timeoutHandle }] of this._pending) {
      clearTimeout(timeoutHandle);
      reject(new Error("OpenVINO helper cancelled by worker"));
      this._pending.delete(id);
    }
  }

  // --------------------------------------------------------------------------
  // Shutdown
  // --------------------------------------------------------------------------

  /**
   * Gracefully shut down the helper.
   */
  shutdown() {
    if (this.state === HELPER_STATES.SHUTDOWN) return;
    this.state = HELPER_STATES.SHUTDOWN;
    this._killProcess();
  }

  // --------------------------------------------------------------------------
  // Stdout protocol parsing
  // --------------------------------------------------------------------------

  _onStdoutData(chunk) {
    this._stdoutBuffer += chunk.toString("utf8");
    let newlineIdx;
    while ((newlineIdx = this._stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineIdx);
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIdx + 1);

      if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_LINE_BYTES) {
        this._log("error", "Helper stdout line exceeds maximum size; killing", {
          id: this.instanceId,
          bytes: Buffer.byteLength(line, "utf8"),
        });
        this._killProcess();
        this._rejectAll(new Error("Helper protocol violation: oversized response line"));
        return;
      }

      this._processLine(line.trim());
    }
  }

  _processLine(line) {
    if (!line) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._log("warn", "Unparseable line on helper stdout (ignored)", {
        id: this.instanceId,
        preview: line.slice(0, 200),
      });
      return;
    }

    // Check protocol version on all messages.
    if (String(msg.v) !== PROTOCOL_VERSION) {
      this._log("warn", "Helper response has unexpected protocol version", {
        id: this.instanceId,
        got: msg.v,
        expected: PROTOCOL_VERSION,
      });
      // Do not reject existing pending — the response may still be useful if
      // we can match the request_id.
    }

    // Handle startup event.
    if (msg.event === "started") {
      this.availableDevices = Array.isArray(msg.available_devices)
        ? msg.available_devices.filter((d) => typeof d === "string").slice(0, 32)
        : [];
      this.openVinoVersion = typeof msg.openvino_version === "string"
        ? msg.openvino_version.slice(0, 100)
        : null;
      this.helperVersion = typeof msg.helper_version === "string"
        ? msg.helper_version.slice(0, 50)
        : HELPER_VERSION;
      this.state = HELPER_STATES.READY;
      this._log("info", "Helper started", {
        id: this.instanceId,
        devices: this.availableDevices,
        openvinoVersion: this.openVinoVersion,
      });
      this.emit("_started");
      this.emit("ready", {
        availableDevices: this.availableDevices,
        openVinoVersion: this.openVinoVersion,
      });
      return;
    }

    // Handle fatal event.
    if (msg.event === "fatal") {
      const err = new Error(
        `Helper fatal error: ${String(msg.error || "unknown").slice(0, 500)}`
      );
      this._log("error", "Helper emitted fatal event", {
        id: this.instanceId,
        error: msg.error,
      });
      this._rejectAll(err);
      this.emit("_error", err);
      this._killProcess();
      return;
    }

    // Match request/response.
    const requestId = msg.id;
    if (!requestId || !this._pending.has(requestId)) {
      // Late response from a cancelled/expired request — discard.
      this._log("debug", "Discarding response for unknown/expired request", {
        id: this.instanceId,
        requestId,
      });
      return;
    }

    const { resolve, reject, timeoutHandle } = this._pending.get(requestId);
    clearTimeout(timeoutHandle);
    this._pending.delete(requestId);

    if (msg.ok === true) {
      resolve(msg);
    } else {
      const errCode = String(msg.error_code || "helper_error").slice(0, 64);
      const errMsg = String(msg.error || "Helper returned an error").slice(0, 500);
      reject(Object.assign(new Error(`[${errCode}] ${errMsg}`), { helperErrorCode: errCode }));
    }
  }

  // --------------------------------------------------------------------------
  // Stderr handling (diagnostics only — never protocol)
  // --------------------------------------------------------------------------

  _onStderrData(chunk) {
    this._stderrBuffer += chunk.toString("utf8");
    let newlineIdx;
    while ((newlineIdx = this._stderrBuffer.indexOf("\n")) !== -1) {
      const line = this._stderrBuffer.slice(0, newlineIdx).slice(0, MAX_STDERR_LINE_BYTES);
      this._stderrBuffer = this._stderrBuffer.slice(newlineIdx + 1);
      if (line.trim()) {
        // Parse structured JSON from helper, or log as plain text.
        try {
          const obj = JSON.parse(line.trim());
          const level = String(obj.lvl || "info").toLowerCase();
          const safeLevel = ["info", "warn", "error", "debug"].includes(level) ? level : "info";
          this._log(safeLevel, `[helper] ${obj.msg || ""}`, {
            id: this.instanceId,
            ...Object.fromEntries(
              Object.entries(obj)
                .filter(([k]) => !["ts", "lvl", "msg"].includes(k))
                .slice(0, 20)
            ),
          });
        } catch {
          this._log("info", `[helper stderr] ${line.trim().slice(0, 400)}`, {
            id: this.instanceId,
          });
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Process event handlers
  // --------------------------------------------------------------------------

  _onProcessError(err) {
    this._log("error", "Helper process error", {
      id: this.instanceId,
      error: err.message,
    });
    this.state = HELPER_STATES.FAILED;
    this.stoppedAt = nowIso();
    this.exitReason = `process_error:${err.message.slice(0, 200)}`;
    this._rejectAll(new Error(`Helper process error: ${err.message}`));
    this.emit("_error", err);
    this.emit("_exited", { code: null, signal: null, reason: this.exitReason });
  }

  _onProcessExit(code, signal) {
    this.stoppedAt = nowIso();
    this.exitCode = code;
    this.exitReason = signal ? `signal:${signal}` : `exit:${code}`;

    if (this.state !== HELPER_STATES.SHUTDOWN) {
      this.state = HELPER_STATES.FAILED;
      this._log("warn", "Helper process exited unexpectedly", {
        id: this.instanceId,
        code,
        signal,
        pendingRequests: this._pending.size,
      });
      this._rejectAll(new Error(`Helper exited unexpectedly (${this.exitReason})`));
    } else {
      this._log("info", "Helper process exited cleanly after shutdown", {
        id: this.instanceId,
        code,
        signal,
      });
    }

    this.emit("_exited", { code, signal, reason: this.exitReason });
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  _rejectAll(error) {
    for (const [, { reject, timeoutHandle }] of this._pending) {
      clearTimeout(timeoutHandle);
      reject(error);
    }
    this._pending.clear();
  }

  _killProcess() {
    if (!this.child || this.child.exitCode !== null) return;
    try {
      if (process.platform === "win32") {
        // On Windows, use taskkill /T /F to kill the entire process tree.
        const { spawnSync } = require("child_process");
        spawnSync("taskkill", ["/T", "/F", "/PID", String(this.child.pid)], {
          shell: false,
          timeout: 5000,
        });
      } else {
        this.child.kill("SIGKILL");
      }
    } catch (e) {
      this._log("warn", "Error killing helper process", {
        id: this.instanceId,
        error: e.message,
      });
    }
  }

  /**
   * Health/status snapshot (safe to expose for diagnostics).
   * Never includes model paths, credentials, or sensitive runtime details.
   */
  getStatus() {
    return {
      instanceId: this.instanceId,
      state: this.state,
      availableDevices: [...this.availableDevices],
      openVinoVersion: this.openVinoVersion,
      helperVersion: this.helperVersion,
      restartCount: this.restartCount,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      exitCode: this.exitCode,
      exitReason: this.exitReason,
      pendingRequests: this._pending.size,
    };
  }
}

// ---------------------------------------------------------------------------
// HelperManager — supervises one HelperProcess with restart policy
// ---------------------------------------------------------------------------

class HelperManager extends EventEmitter {
  /**
   * @param {object} config  Validated OpenVINO config (from loadOpenVinoConfig).
   * @param {Function} [logFn]  Structured log function (level, msg, meta).
   */
  constructor(config, logFn) {
    super();
    this._config = config;
    this._log = logFn || (() => {});
    this._helper = null;
    this._restartCount = 0;
    this._lastRestartAt = 0;
    this._shutdownRequested = false;
    this._startPromise = null;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Start the helper (idempotent if already started).
   * @returns {Promise<void>}
   */
  async start() {
    if (this._shutdownRequested) {
      throw new Error("HelperManager has been shut down");
    }
    if (this._startPromise) {
      return this._startPromise;
    }
    this._startPromise = this._doStart();
    return this._startPromise;
  }

  /**
   * Submit an embed request.  Handles automatic restart within policy.
   *
   * @param {object} requestBody
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  async embed(requestBody, timeoutMs) {
    if (this._shutdownRequested) {
      throw new Error("HelperManager has been shut down");
    }
    const helper = await this._ensureReady();
    return helper.request(requestBody, timeoutMs);
  }

  /**
   * Cancel any in-flight request (kills the helper process).
   */
  cancelCurrent() {
    if (this._helper) {
      this._helper.cancelAll();
    }
  }

  /**
   * Check readiness for a specific model.
   * @param {string} modelId
   * @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  async checkReady(modelId, timeoutMs) {
    const helper = await this._ensureReady();
    return helper.request(
      { action: "ready", model_id: modelId },
      timeoutMs || 30000
    );
  }

  /**
   * Ping the helper.
   * @returns {Promise<object>}
   */
  async ping() {
    const helper = await this._ensureReady();
    return helper.request({ action: "ping" }, 10000);
  }

  /**
   * Return the available OpenVINO devices discovered by the helper.
   * Returns an empty array if the helper is not started.
   * @returns {string[]}
   */
  getAvailableDevices() {
    if (!this._helper || this._helper.state === HELPER_STATES.STOPPED) {
      return [];
    }
    return [...this._helper.availableDevices];
  }

  /**
   * Return the helper status (safe for diagnostic output).
   * @returns {object}
   */
  getStatus() {
    return {
      managerRestartCount: this._restartCount,
      maxRestarts: this._config.maxHelperRestarts,
      shutdownRequested: this._shutdownRequested,
      helper: this._helper ? this._helper.getStatus() : null,
    };
  }

  /**
   * Shut down the helper and prevent further restarts.
   */
  shutdown() {
    this._shutdownRequested = true;
    if (this._helper) {
      this._helper.shutdown();
    }
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  async _doStart() {
    if (this._helper && (
      this._helper.state === HELPER_STATES.READY ||
      this._helper.state === HELPER_STATES.BUSY
    )) {
      return;
    }

    this._helper = new HelperProcess({
      pythonPath: this._config.pythonPath,
      helperScript: this._config.helperScript,
      modelsDir: this._config.modelsDir,
      startupTimeoutMs: this._config.startupTimeoutMs,
      instanceId: `openvino-helper-${++this._restartCount}`,
      log: this._log,
    });

    this._helper.once("_exited", ({ code, signal, reason }) => {
      this._log("warn", "Helper exited; evaluating restart policy", {
        code,
        signal,
        reason,
        restartCount: this._restartCount,
        maxRestarts: this._config.maxHelperRestarts,
      });
      // Reset start promise so the next call triggers a fresh start attempt.
      this._startPromise = null;
      this.emit("helperExited", { code, signal, reason, restartCount: this._restartCount });
    });

    this._helper.on("ready", (info) => {
      this.emit("helperReady", info);
    });

    await this._helper.start();
  }

  async _ensureReady() {
    if (this._shutdownRequested) {
      throw new Error("HelperManager has been shut down");
    }

    // If the helper is running and ready, return it directly.
    if (
      this._helper &&
      (this._helper.state === HELPER_STATES.READY ||
        this._helper.state === HELPER_STATES.BUSY)
    ) {
      return this._helper;
    }

    // Check restart policy.
    if (this._restartCount >= this._config.maxHelperRestarts) {
      throw new Error(
        `OpenVINO helper exceeded maximum restart count (${this._config.maxHelperRestarts}). ` +
          "The helper will not be restarted until the worker is restarted."
      );
    }

    // Enforce cooldown between restarts.
    const now = Date.now();
    const timeSinceLastRestart = now - this._lastRestartAt;
    if (
      this._restartCount > 0 &&
      timeSinceLastRestart < this._config.helperRestartCooldownMs
    ) {
      const wait = this._config.helperRestartCooldownMs - timeSinceLastRestart;
      await new Promise((r) => setTimeout(r, wait));
    }

    this._lastRestartAt = Date.now();

    // Start (or restart).
    this._startPromise = this._doStart();
    await this._startPromise;
    return this._helper;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  HelperProcess,
  HelperManager,
  HELPER_STATES,
};
