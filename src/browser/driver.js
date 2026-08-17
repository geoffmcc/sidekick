"use strict";

// Browser runtime driver: locates the managed Chromium installation, owns the
// single shared browser process, and reports runtime health.
//
// The runtime is installed OUT OF BAND by `node scripts/install-browser.js`
// (see docs/browser-automation.md). Nothing here downloads anything: a missing
// browser is a health state and an actionable error, never a silent fetch.
// The pinned Chromium revision comes from playwright-core's own browsers.json,
// so the lockfile pins the browser build the same way it pins the library.

const fs = require("fs");
const path = require("path");
const { browserConfig, PROCESS_MARKER } = require("./config");

// Per-platform executable locations inside a Playwright browser directory.
const CHROMIUM_CANDIDATES = [
  ["chrome-linux64", "chrome"],
  ["chrome-linux", "chrome"],
  ["chrome-win", "chrome.exe"],
  ["chrome-win64", "chrome.exe"],
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
];
const HEADLESS_SHELL_CANDIDATES = [
  ["chrome-linux64", "headless_shell"],
  ["chrome-linux", "headless_shell"],
  ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  ["chrome-win", "headless_shell.exe"],
];

let browserPromise = null;
let lastLaunchError = null;

function chromiumRevision() {
  try {
    // browsers.json is not an exported subpath; resolve it via the package root.
    const pkgRoot = path.dirname(require.resolve("playwright-core/package.json"));
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, "browsers.json"), "utf8"));
    const entry = (manifest.browsers || []).find((b) => b.name === "chromium");
    return entry ? { revision: entry.revision, version: entry.browserVersion } : null;
  } catch {
    return null;
  }
}

function findExecutableIn(root, revision) {
  const dirs = [];
  if (revision) {
    dirs.push({ dir: path.join(root, `chromium-${revision}`), candidates: CHROMIUM_CANDIDATES });
    dirs.push({ dir: path.join(root, `chromium_headless_shell-${revision}`), candidates: HEADLESS_SHELL_CANDIDATES });
  }
  // Fallback: any chromium-* directory (newest revision first) so a manually
  // maintained installation is still discoverable — the health report names
  // exactly what was found.
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return null; }
  for (const entry of entries.sort().reverse()) {
    if (entry.startsWith("chromium-")) dirs.push({ dir: path.join(root, entry), candidates: CHROMIUM_CANDIDATES });
    if (entry.startsWith("chromium_headless_shell-")) dirs.push({ dir: path.join(root, entry), candidates: HEADLESS_SHELL_CANDIDATES });
  }
  for (const { dir, candidates } of dirs) {
    for (const candidate of candidates) {
      const executable = path.join(dir, ...candidate);
      try {
        if (fs.statSync(executable).isFile()) return executable;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Locate the Chromium executable. Resolution order:
 *   1. SIDEKICK_BROWSER_EXECUTABLE (explicit operator override);
 *   2. the managed installation under SIDEKICK_BROWSER_BROWSERS_PATH;
 *   3. the default Playwright cache (~/.cache/ms-playwright) — a development
 *      convenience; production installs use the managed path.
 * Returns { executable, source } or { executable: null, checked: [...] }.
 */
function resolveExecutable(config = browserConfig()) {
  const revision = chromiumRevision();
  const checked = [];

  if (config.executableOverride) {
    checked.push(config.executableOverride);
    try {
      if (fs.statSync(config.executableOverride).isFile()) {
        return { executable: config.executableOverride, source: "override", revision };
      }
    } catch { /* fall through */ }
    return { executable: null, checked, revision };
  }

  const roots = [
    { root: config.browsersPath, source: "managed" },
    {
      root: process.env.PLAYWRIGHT_BROWSERS_PATH
        || path.join(process.env.HOME || process.env.USERPROFILE || "", ".cache", "ms-playwright"),
      source: "playwright-cache",
    },
  ];
  for (const { root, source } of roots) {
    if (!root) continue;
    checked.push(root);
    const executable = findExecutableIn(root, revision ? revision.revision : null);
    if (executable) return { executable, source, revision };
  }
  return { executable: null, checked, revision };
}

/**
 * Launch (or reuse) the shared browser process. Sessions isolate through
 * separate BrowserContexts; one Chromium process serves them all. Returns the
 * connected Browser or throws a structured error.
 */
async function getBrowser({ onDisconnected } = {}) {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.isConnected()) return existing;
    browserPromise = null;
  }
  const config = browserConfig();
  const resolved = resolveExecutable(config);
  if (!resolved.executable) {
    const error = new Error(
      "Browser runtime is not installed. Run `node scripts/install-browser.js` on this host " +
      `(checked: ${resolved.checked.join(", ")})`
    );
    error.code = "browser_runtime_missing";
    throw error;
  }
  browserPromise = (async () => {
    const { chromium } = require("playwright-core");
    try {
      const browser = await chromium.launch({
        executablePath: resolved.executable,
        headless: config.headless,
        args: [
          `${PROCESS_MARKER}=${process.pid}`,
          // Keep WebRTC media/data traffic inside the proxy boundary: without
          // this, WebRTC's UDP path bypasses the HTTP proxy and can disclose
          // host ICE candidates or open non-proxied data channels.
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      });
      lastLaunchError = null;
      browser.on("disconnected", () => {
        browserPromise = null;
        if (typeof onDisconnected === "function") {
          try { onDisconnected(); } catch { /* observer only */ }
        }
      });
      return browser;
    } catch (error) {
      lastLaunchError = String(error.message || error).slice(0, 500);
      browserPromise = null;
      const wrapped = new Error(`Browser launch failed: ${lastLaunchError}`);
      wrapped.code = "browser_launch_failed";
      throw wrapped;
    }
  })();
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return { closed: false };
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser && browser.isConnected()) {
    try { await browser.close(); } catch { /* already dying */ }
    return { closed: true };
  }
  return { closed: false };
}

function isBrowserRunning() {
  return browserPromise !== null;
}

/**
 * Runtime health without launching anything (cheap), or with a real launch
 * probe when `deep` is set. States: disabled | missing_runtime | launch_failed
 * | ready | running.
 */
async function runtimeHealth({ deep = false } = {}) {
  const config = browserConfig();
  if (!config.enabled) return { status: "disabled", detail: "SIDEKICK_BROWSER_ENABLED=false" };
  const resolved = resolveExecutable(config);
  if (!resolved.executable) {
    return {
      status: "missing_runtime",
      detail: "Chromium is not installed; run `node scripts/install-browser.js`",
      checked: resolved.checked,
      expected_revision: resolved.revision || null,
    };
  }
  const base = {
    executable: resolved.executable,
    executable_source: resolved.source,
    expected_revision: resolved.revision || null,
    headless: config.headless,
  };
  if (isBrowserRunning()) return { status: "running", ...base };
  if (!deep) {
    return lastLaunchError
      ? { status: "launch_failed", detail: lastLaunchError, ...base }
      : { status: "ready", ...base };
  }
  try {
    const browser = await getBrowser();
    const version = browser.version();
    return { status: "running", browser_version: version, ...base };
  } catch (error) {
    return { status: "launch_failed", detail: String(error.message || error).slice(0, 500), ...base };
  }
}

module.exports = {
  resolveExecutable,
  chromiumRevision,
  getBrowser,
  closeBrowser,
  isBrowserRunning,
  runtimeHealth,
};
