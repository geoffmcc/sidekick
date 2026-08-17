"use strict";

// Browser subsystem configuration.
//
// Every value is read from the environment on each call (matching the
// policy-env convention) so operators can adjust limits without editing code,
// and clamped so a typo cannot configure an unbounded browser. Dangerous
// posture (private-network egress) is opt-in and never a default.

const path = require("path");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return String(raw).toLowerCase() === "true" || raw === "1";
}

function int(name, fallback, { min, max }) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(min, Math.min(max, value));
}

function dataDir() {
  return process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");
}

function browserConfig() {
  const root = dataDir();
  return {
    enabled: bool("SIDEKICK_BROWSER_ENABLED", true),
    // Managed browser installation path — deliberately under the data dir so
    // deploys (which replace the app directory) do not delete the browser.
    browsersPath: process.env.SIDEKICK_BROWSER_BROWSERS_PATH || path.join(root, "browser", "ms-playwright"),
    executableOverride: process.env.SIDEKICK_BROWSER_EXECUTABLE || null,
    headless: bool("SIDEKICK_BROWSER_HEADLESS", true),
    // Private/loopback egress for browser sessions. Off by default; a session
    // must ALSO opt in per-open, so this is a ceiling, not a grant.
    allowPrivateNetwork: bool("SIDEKICK_BROWSER_ALLOW_PRIVATE_NETWORK", false),
    maxSessions: int("SIDEKICK_BROWSER_MAX_SESSIONS", 3, { min: 1, max: 16 }),
    maxPagesPerSession: int("SIDEKICK_BROWSER_MAX_PAGES", 5, { min: 1, max: 25 }),
    sessionTtlMs: int("SIDEKICK_BROWSER_SESSION_TTL_MS", 30 * 60 * 1000, { min: 60 * 1000, max: 4 * 60 * 60 * 1000 }),
    idleTimeoutMs: int("SIDEKICK_BROWSER_IDLE_TIMEOUT_MS", 5 * 60 * 1000, { min: 30 * 1000, max: 60 * 60 * 1000 }),
    navTimeoutMs: int("SIDEKICK_BROWSER_NAV_TIMEOUT_MS", 30 * 1000, { min: 1000, max: 120 * 1000 }),
    actionTimeoutMs: int("SIDEKICK_BROWSER_ACTION_TIMEOUT_MS", 10 * 1000, { min: 500, max: 60 * 1000 }),
    maxDownloadBytes: int("SIDEKICK_BROWSER_MAX_DOWNLOAD_BYTES", 25 * 1024 * 1024, { min: 1024, max: 500 * 1024 * 1024 }),
    maxUploadBytes: int("SIDEKICK_BROWSER_MAX_UPLOAD_BYTES", 25 * 1024 * 1024, { min: 1024, max: 500 * 1024 * 1024 }),
    maxOutputChars: int("SIDEKICK_BROWSER_MAX_OUTPUT_CHARS", 20000, { min: 500, max: 200000 }),
    maxSequenceSteps: int("SIDEKICK_BROWSER_MAX_SEQUENCE_STEPS", 20, { min: 1, max: 50 }),
    maxExtractMatches: int("SIDEKICK_BROWSER_MAX_EXTRACT_MATCHES", 50, { min: 1, max: 500 }),
    artifactsDir: path.join(root, "browser", "artifacts"),
    tmpDir: path.join(root, "browser", "tmp"),
  };
}

// Marker switch added to every Chromium launch so orphaned browser processes
// are identifiable (and reapable) after a crashed Sidekick process. Chromium
// ignores unknown switches.
const PROCESS_MARKER = "--sidekick-browser-session";

module.exports = { browserConfig, dataDir, DATA_DIR, PROCESS_MARKER };
