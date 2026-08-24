"use strict";

// Browser session lifecycle.
//
// A session is one isolated BrowserContext (own cookies, storage, cache and
// authentication state) plus the per-session egress proxy that all of its
// traffic traverses. Sessions are ephemeral by design: bounded count, bounded
// page count, bounded lifetime, idle-reaped, and deterministically cleaned up
// on close, cancellation, crash and shutdown. There is no persistent profile
// and no path to an operator's personal browser profile.
//
// Sessions live in the process that dispatches browser tool calls (normally
// sidekick-mcp). They are deliberately NOT shared across processes: a browser
// context is process-bound, and pretending otherwise would fake a capability
// the runtime does not have.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { browserConfig } = require("./config");
const egress = require("./egress");
const driver = require("./driver");
const browserArtifacts = require("./artifacts");

const sessions = new Map();
const EVIDENCE_CAP = 200;

function newSessionId() {
  return `bsn_${crypto.randomBytes(8).toString("hex")}`;
}

function record(list, entry) {
  if (list.length >= EVIDENCE_CAP) list.shift();
  list.push(entry);
}

// Download filenames are hostile HTTP metadata. Artifact custody sanitizes
// the filesystem name later, but the session record is returned before that
// and may be logged or handed to an agent. Bound it and remove controls here
// so a remote Content-Disposition value cannot inject terminal/log controls or
// consume unbounded response memory.
function safeDownloadFilename(value) {
  const safe = String(value || "download")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .slice(0, 200);
  return safe || "download";
}

function sessionSummary(session) {
  return {
    id: session.id,
    label: session.label || null,
    project: session.project || null,
    created_at: new Date(session.createdAt).toISOString(),
    last_used_at: new Date(session.lastUsedAt).toISOString(),
    expires_at: new Date(session.expiresAt).toISOString(),
    pages: session.pageOrder.length,
    active_page: session.activePageId,
    downloads: session.downloads.length,
    blocked_requests: session.blockedRequests.length,
    allow_private_network: session.policy.allowPrivate,
    network_scope: session.policy.networkScope,
    network_scope_mode: session.policy.scope ? "named" : (session.policy.allowPrivate ? "legacy_restricted" : "public_only"),
    allowed_hosts: session.policy.allowedHosts || null,
  };
}

function adoptPage(session, page, { origin = "created" } = {}) {
  const config = browserConfig();
  for (const existing of session.pages.values()) {
    if (existing.page === page) return existing.id;
  }
  if (session.pageOrder.length >= config.maxPagesPerSession) {
    record(session.warnings, {
      at: new Date().toISOString(),
      warning: `page limit (${config.maxPagesPerSession}) reached; ${origin === "popup" ? "popup" : "page"} was closed`,
    });
    page.close().catch(() => {});
    return null;
  }
  session.pageCounter += 1;
  const pageId = `pg_${session.pageCounter}`;
  session.pages.set(pageId, { id: pageId, page, origin });
  session.pageOrder.push(pageId);
  if (!session.activePageId) session.activePageId = pageId;

  page.on("download", (download) => captureDownload(session, download));
  page.on("crash", () => {
    record(session.warnings, { at: new Date().toISOString(), warning: `page ${pageId} crashed` });
  });
  page.on("close", () => {
    session.pages.delete(pageId);
    session.pageOrder = session.pageOrder.filter((id) => id !== pageId);
    if (session.activePageId === pageId) session.activePageId = session.pageOrder[session.pageOrder.length - 1] || null;
    session.sensitivePages.delete(pageId);
  });
  return pageId;
}

async function captureDownload(session, download) {
  const config = browserConfig();
  const entry = {
    at: new Date().toISOString(),
    url: String(download.url() || "").slice(0, 500),
    suggested_filename: safeDownloadFilename(download.suggestedFilename()),
    status: "pending",
  };
  record(session.downloads, entry);
  try {
    const tempPath = await download.path();
    if (!tempPath) {
      entry.status = "failed";
      entry.error = String(await download.failure() || "download produced no file");
      return;
    }
    // Size is enforced post-write: Chromium exposes no pre-download byte cap
    // and download.path() resolves only once the file is complete, so an
    // oversized download is rejected and deleted here rather than kept. The
    // bytes transit an isolated Playwright temp dir first; deletion and the
    // limit bound the exposure. A truly endless download is additionally
    // bounded by the per-action/navigation timeout the dispatcher enforces.
    const size = fs.statSync(tempPath).size;
    if (size > config.maxDownloadBytes) {
      entry.status = "rejected";
      entry.error = `download of ${size} bytes exceeds the ${config.maxDownloadBytes}-byte limit`;
      try { await download.delete(); } catch { /* temp cleanup */ }
      return;
    }
    const artifact = browserArtifacts.storeArtifact({
      sessionId: session.id,
      kind: "download",
      name: download.suggestedFilename() || "download",
      sourcePath: tempPath,
      sensitivity: "sensitive", // downloaded content is untrusted and unclassified
      executionContext: session.executionContext,
      metadata: { source_url: entry.url },
    });
    entry.status = artifact.custody && artifact.custody.status === "failed" ? "stored_custody_failed" : "stored";
    entry.artifact_id = artifact.artifact_id;
    entry.sha256 = artifact.sha256;
    entry.byte_size = artifact.byte_size;
    entry.storage_ref = artifact.storage_ref;
    entry.custody = artifact.custody;
    try { await download.delete(); } catch { /* temp cleanup */ }
  } catch (error) {
    entry.status = "failed";
    entry.error = String(error.message || error).slice(0, 300);
  }
}

/**
 * Open a new isolated session. `options` come from the tool caller; `context`
 * is the dispatcher execution context (project/execution linkage).
 */
async function openSession(options = {}, executionContext = null) {
  const config = browserConfig();
  if (!config.enabled) {
    const error = new Error("Browser subsystem is disabled (SIDEKICK_BROWSER_ENABLED=false)");
    error.code = "browser_disabled";
    throw error;
  }
  if (sessions.size >= config.maxSessions) {
    const error = new Error(`Session limit reached (${config.maxSessions}). Close a session or wait for idle reaping.`);
    error.code = "browser_session_limit";
    throw error;
  }
  if (options.allow_private_network === true && !options.network_scope) {
    const error = new Error("Private-network browser access requires an operator-created named network_scope; allow_private_network cannot grant private access");
    error.code = "browser_named_network_scope_required";
    throw error;
  }
  const policy = egress.buildSessionPolicy({
    allowPrivateNetwork: options.allow_private_network === true,
    allowedHosts: options.allowed_hosts,
    networkScope: options.network_scope,
  }, config);
  if (policy.scopeError) {
    const error = new Error(policy.scopeError);
    error.code = "browser_network_scope_invalid";
    throw error;
  }
  if (policy.scope && policy.scope.allow_private_addresses && !config.allowPrivateNetwork) {
    const error = new Error("The named network scope permits private addresses but the operator kill switch is disabled");
    error.code = "browser_private_network_not_enabled";
    throw error;
  }

  const id = newSessionId();
  const session = {
    id,
    label: options.label ? String(options.label).slice(0, 120) : null,
    project: executionContext?.project || options.project || null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    expiresAt: Date.now() + config.sessionTtlMs,
    policy,
    proxy: null,
    context: null,
    pages: new Map(),
    pageOrder: [],
    activePageId: null,
    pageCounter: 0,
    downloads: [],
    blockedRequests: [],
    warnings: [],
    requestCount: 0,
    secretValues: new Set(),
    sensitivePages: new Set(),
    executionContext: executionContext
      ? {
          project: executionContext.project || null,
          executionId: executionContext.executionId || null,
          taskId: executionContext.taskId || null,
          sessionId: executionContext.sessionId || null,
        }
      : null,
    closed: false,
  };

  // Per-session proxy credential so the loopback proxy is not an open relay for
  // other local processes. Only this session's browser context carries it.
  const proxyCredential = {
    username: `sk_${crypto.randomBytes(6).toString("hex")}`,
    password: crypto.randomBytes(24).toString("hex"),
  };
  session.proxy = await egress.createSessionProxy(policy, {
    credential: proxyCredential,
    onBlocked: (entry) => record(session.blockedRequests, entry),
    onRequest: () => { session.requestCount += 1; },
  });

  try {
    const browser = await driver.getBrowser({ onDisconnected: onBrowserDisconnected });
    session.context = await browser.newContext({
      proxy: {
        server: session.proxy.url,
        bypass: "<-loopback>",
        username: proxyCredential.username,
        password: proxyCredential.password,
      },
      acceptDownloads: true,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 720 },
    });
  } catch (error) {
    await session.proxy.close().catch(() => {});
    throw error;
  }

  session.context.setDefaultTimeout(config.actionTimeoutMs);
  session.context.setDefaultNavigationTimeout(config.navTimeoutMs);

  // Layer 1: URL-text policy at route interception. The proxy (layer 2) is the
  // authority — this layer refuses early with a precise reason and records
  // evidence, including for requests route interception can see but the agent
  // never explicitly made.
  await session.context.route("**/*", (route) => {
    const url = route.request().url();
    const refusal = egress.evaluateBrowserUrl(url, policy);
    if (refusal) {
      record(session.blockedRequests, {
        kind: "route",
        target: String(url).slice(0, 500),
        reason: refusal,
        at: new Date().toISOString(),
      });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  // WebSockets do not traverse route(); enforce the same host policy on them.
  if (typeof session.context.routeWebSocket === "function") {
    await session.context.routeWebSocket("**/*", (ws) => {
      const refusal = egress.evaluateBrowserUrl(ws.url(), policy, { schemes: ["ws:", "wss:", "http:", "https:"] });
      if (refusal) {
        record(session.blockedRequests, {
          kind: "websocket",
          target: String(ws.url()).slice(0, 500),
          reason: refusal,
          at: new Date().toISOString(),
        });
        ws.close({ code: 1008, reason: "blocked by egress policy" });
        return;
      }
      ws.connectToServer();
    });
  }

  session.context.on("page", (page) => adoptPage(session, page, { origin: "popup" }));

  const page = await session.context.newPage();
  adoptPage(session, page, { origin: "created" });

  sessions.set(id, session);
  return session;
}

function getSession(id, { project = null } = {}) {
  const session = sessions.get(String(id || ""));
  if (!session || session.closed) {
    const error = new Error(`No open browser session "${id}". Use action="open" first, or action="list" to see sessions.`);
    error.code = "browser_session_not_found";
    throw error;
  }
  // Cross-project isolation, fail-closed: a session opened under a project is
  // reachable ONLY from a call carrying that same project. A null-project
  // (unscoped) call must not reach a project-bound session, or an unscoped
  // caller could hijack any tenant's authenticated session. Truly unscoped
  // sessions (no project) remain reachable from unscoped calls.
  if (session.project && session.project !== project) {
    const error = new Error(`Browser session "${id}" belongs to project "${session.project}" and is not usable from this context`);
    error.code = "browser_session_project_mismatch";
    throw error;
  }
  session.lastUsedAt = Date.now();
  return session;
}

function activePage(session, pageId = null) {
  const id = pageId || session.activePageId;
  const entry = id ? session.pages.get(id) : null;
  if (!entry) {
    const error = new Error(pageId
      ? `No page "${pageId}" in session ${session.id}`
      : `Session ${session.id} has no open pages`);
    error.code = "browser_page_not_found";
    throw error;
  }
  return entry;
}

async function closeSession(id, { reason = "closed" } = {}) {
  const session = sessions.get(String(id || ""));
  if (!session) return { closed: false, reason: "not_found" };
  sessions.delete(session.id);
  if (session.closed) return { closed: false, reason: "already_closed" };
  session.closed = true;
  try { await session.context.close(); } catch { /* context may be gone */ }
  try { await session.proxy.close(); } catch { /* proxy may be gone */ }
  // Free the shared browser process when the last session closes; it relaunches
  // on demand.
  if (sessions.size === 0) await driver.closeBrowser().catch(() => {});
  return { closed: true, reason };
}

function onBrowserDisconnected() {
  for (const session of [...sessions.values()]) {
    record(session.warnings, { at: new Date().toISOString(), warning: "browser process disconnected; session terminated" });
    sessions.delete(session.id);
    session.closed = true;
    session.proxy.close().catch(() => {});
  }
}

/** Reap expired and idle sessions. Returns what was reaped and why. */
async function sweepSessions() {
  const config = browserConfig();
  const now = Date.now();
  const reaped = [];
  for (const session of [...sessions.values()]) {
    let reason = null;
    if (now >= session.expiresAt) reason = "max_lifetime";
    else if (now - session.lastUsedAt >= config.idleTimeoutMs) reason = "idle_timeout";
    if (reason) {
      await closeSession(session.id, { reason });
      reaped.push({ id: session.id, reason });
    }
  }
  return reaped;
}

async function closeAllSessions({ reason = "shutdown" } = {}) {
  const closed = [];
  for (const session of [...sessions.values()]) {
    await closeSession(session.id, { reason });
    closed.push(session.id);
  }
  await driver.closeBrowser().catch(() => {});
  return closed;
}

// List sessions visible to a calling context. A scoped caller sees only its
// own project's sessions plus unscoped ones; an unscoped caller sees only
// unscoped sessions. This prevents cross-tenant session-id/metadata disclosure
// (session ids are otherwise unguessable, and `list` must not defeat that).
function listSessions({ project = null } = {}) {
  return [...sessions.values()]
    .filter((session) => !session.project || session.project === project)
    .map(sessionSummary);
}

function sessionCount() {
  return sessions.size;
}

/** Track a secret used in this session so outputs can be scrubbed. */
function trackSecret(session, value) {
  if (value && typeof value === "string" && value.length >= 4) session.secretValues.add(value);
}

function markPageSensitive(session, pageId) {
  if (pageId) session.sensitivePages.add(pageId);
}

function isPageSensitive(session, pageId) {
  return session.sensitivePages.has(pageId);
}

/**
 * Scrub every tracked secret value out of text returned to callers. Applied to
 * all page-derived output so a filled credential cannot be read back through
 * inspection, extraction or assertion results.
 */
function scrubSecrets(session, text) {
  if (typeof text !== "string" || !session.secretValues.size) return text;
  let result = text;
  for (const value of session.secretValues) {
    result = result.split(value).join("[REDACTED:secret]");
  }
  return result;
}

function scrubSecretsDeep(session, value) {
  if (typeof value === "string") return scrubSecrets(session, value);
  if (Array.isArray(value)) return value.map((entry) => scrubSecretsDeep(session, entry));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = scrubSecretsDeep(session, entry);
    return out;
  }
  return value;
}

module.exports = {
  openSession,
  getSession,
  activePage,
  adoptPage,
  closeSession,
  closeAllSessions,
  sweepSessions,
  listSessions,
  sessionCount,
  sessionSummary,
  trackSecret,
  markPageSensitive,
  isPageSensitive,
  safeDownloadFilename,
  scrubSecrets,
  scrubSecretsDeep,
};
