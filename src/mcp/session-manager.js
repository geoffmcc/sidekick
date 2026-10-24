const crypto = require("crypto");
const { WebStandardStreamableHTTPServerTransport } = require("@modelcontextprotocol/server");
const { MAX_MCP_REQUEST_BODY_BYTES, MAX_MCP_SESSIONS, MAX_MCP_SESSIONS_PER_IDENTITY } = require("./limits");
const { sanitizeMcpLogLabel } = require("./log-label");

function logSafeSessionId(sessionId) {
  return sanitizeMcpLogLabel(sessionId, "invalid");
}

function safeClientInfo(clientInfo) {
  if (!clientInfo || typeof clientInfo !== "object" || Array.isArray(clientInfo)) return null;
  const name = typeof clientInfo.name === "string" ? sanitizeMcpLogLabel(clientInfo.name) : null;
  const version = typeof clientInfo.version === "string" ? sanitizeMcpLogLabel(clientInfo.version) : null;
  return name || version ? { ...(name ? { name } : {}), ...(version ? { version } : {}) } : null;
}

function sameSessionPrincipal(established, presented) {
  if (!established || !presented || typeof established !== "object" || typeof presented !== "object") return false;
  const establishedPrincipal = typeof established.principal_id === "string" && established.principal_id ? established.principal_id : null;
  const presentedPrincipal = typeof presented.principal_id === "string" && presented.principal_id ? presented.principal_id : null;
  if (establishedPrincipal || presentedPrincipal) return Boolean(establishedPrincipal && presentedPrincipal && establishedPrincipal === presentedPrincipal);
  return typeof established.authentication_method === "string" && established.authentication_method === presented.authentication_method;
}

function createSessionManager({ createMcpServer, logDebug, now = () => Date.now(), sessionIdGenerator, maxSessions = MAX_MCP_SESSIONS, maxSessionsPerIdentity = MAX_MCP_SESSIONS_PER_IDENTITY } = {}) {
  const sessions = new Map();
  const staleSessionMap = new Map();
  const generateSessionId = sessionIdGenerator || (() => `sess-${crypto.randomBytes(24).toString("base64url")}`);

  function sessionIdentityKey(authIdentity) {
    if (typeof authIdentity?.principal_id === "string" && authIdentity.principal_id) return `principal:${authIdentity.principal_id}`;
    if (typeof authIdentity?.authentication_method === "string" && authIdentity.authentication_method) return `auth:${authIdentity.authentication_method}`;
    return "identityless";
  }

  function getSessionCapacity(authIdentity) {
    if (sessions.size >= maxSessions) return { allowed: false, scope: "global", limit: maxSessions };
    const key = sessionIdentityKey(authIdentity);
    let owned = 0;
    for (const entry of sessions.values()) {
      if (sessionIdentityKey(entry.authIdentity) === key) owned += 1;
    }
    if (owned >= maxSessionsPerIdentity) return { allowed: false, scope: "identity", limit: maxSessionsPerIdentity };
    return { allowed: true, scope: null, limit: null };
  }

  function registerSession(sessionId, server, transport, metadata = {}) {
    if (!getSessionCapacity(metadata.authIdentity).allowed) return false;
    const safeUserAgent = typeof metadata.userAgent === "string" ? sanitizeMcpLogLabel(metadata.userAgent) : null;
    const safeInfo = safeClientInfo(metadata.clientInfo);
    logDebug("REGISTER_SESSION", { sessionId: logSafeSessionId(sessionId), sessionCount: sessions.size + 1, userAgent: safeUserAgent, clientInfo: safeInfo });
    sessions.set(sessionId, {
      server,
      transport,
      createdAt: now(),
      lastAccess: now(),
      initialized: false,
      userAgent: safeUserAgent,
      clientInfo: safeInfo,
      authIdentity: metadata.authIdentity || null,
      authState: metadata.authState || { current: metadata.authIdentity || null }
    });
    return true;
  }

  function markSessionInitialized(sessionId) {
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.initialized = true;
      logDebug("SESSION_INITIALIZED", { sessionId: logSafeSessionId(sessionId) });
    }
  }

  function authorizeSessionIdentity(sessionId, authIdentity) {
    const entry = sessions.get(sessionId);
    if (!entry || !sameSessionPrincipal(entry.authIdentity, authIdentity)) return false;
    if (entry.authState) entry.authState.current = authIdentity;
    return true;
  }

  async function getTransportForRequest(sessionId, metadata = {}, options = {}) {
    logDebug("getTransportForRequest", { requestedSessionId: sessionId == null ? null : logSafeSessionId(sessionId), sessionCount: sessions.size });
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId);
      if (metadata.authIdentity !== undefined && !authorizeSessionIdentity(sessionId, metadata.authIdentity)) {
        logDebug("SESSION_IDENTITY_MISMATCH", { sessionId: logSafeSessionId(sessionId) });
        return { transport: null, isNew: false, identityMismatch: true };
      }
      const age = now() - entry.createdAt;
      const idle = now() - entry.lastAccess;
      entry.lastAccess = now();
      logDebug("REUSE_SESSION", { sessionId: logSafeSessionId(sessionId), age_ms: age, idle_ms: idle });
      return { transport: entry.transport, isNew: false };
    }

    if (sessionId && !sessions.has(sessionId)) {
      const staleEntry = staleSessionMap.get(sessionId);
      const replacementId = staleEntry?.replacementId;
      if (replacementId && sessions.has(replacementId)) {
        logDebug("STALE_SESSION_KNOWN_REPLACEMENT", { staleSessionId: logSafeSessionId(sessionId), replacementId: logSafeSessionId(replacementId) });
        if (options.allowStalePost) {
          const entry = sessions.get(replacementId);
          if (metadata.authIdentity !== undefined && !authorizeSessionIdentity(replacementId, metadata.authIdentity)) {
            logDebug("SESSION_IDENTITY_MISMATCH", { sessionId: logSafeSessionId(sessionId), replacementId: logSafeSessionId(replacementId) });
            return { transport: null, isNew: false, newSessionId: replacementId, identityMismatch: true };
          }
          entry.lastAccess = now();
          return { transport: entry.transport, isNew: false, newSessionId: replacementId, staleRedirect: false, replacedStaleSession: true };
        }
        return { transport: null, isNew: false, newSessionId: replacementId, staleRedirect: true };
      }

      logDebug("UNKNOWN_SESSION", { sessionId: logSafeSessionId(sessionId), sessionCount: sessions.size });
      return { transport: null, isNew: false, newSessionId: null, staleRedirect: true };
    }

    const capacity = getSessionCapacity(metadata.authIdentity);
    if (!capacity.allowed) {
      logDebug("SESSION_CAPACITY_REACHED", { scope: capacity.scope, limit: capacity.limit });
      return { transport: null, isNew: false, capacityExceeded: true, capacityScope: capacity.scope, capacityLimit: capacity.limit };
    }
    const newSessionId = generateSessionId();
    const authState = { current: metadata.authIdentity || null };
    const server = createMcpServer(() => authState.current);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId, enableJsonResponse: true, maxRequestBodySize: MAX_MCP_REQUEST_BODY_BYTES });
    if (!registerSession(newSessionId, server, transport, { ...metadata, authState })) {
      await Promise.allSettled([transport.close?.(), server.close?.()]);
      const latestCapacity = getSessionCapacity(metadata.authIdentity);
      return { transport: null, isNew: false, capacityExceeded: true, capacityScope: latestCapacity.scope, capacityLimit: latestCapacity.limit };
    }
    await server.connect(transport);
    logDebug("CREATED_NEW_TRANSPORT", { newSessionId: logSafeSessionId(newSessionId) });
    return { transport, isNew: true, newSessionId };
  }

  function getSession(sessionId) { return sessions.get(sessionId); }
  function hasSession(sessionId) { return sessions.has(sessionId); }
  async function closeSessionEntry(sessionId, entry) {
    sessions.delete(sessionId);
    for (const resource of [entry.transport, entry.server]) {
      if (!resource || typeof resource.close !== "function") continue;
      try {
        await resource.close();
      } catch {
        const safeSessionId = typeof sessionId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)
          ? sessionId
          : null;
        try { logDebug("SESSION_CLOSE_ERROR", { sessionId: safeSessionId, error: "internal_error" }); } catch {}
      }
    }
  }

  function deleteSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    void closeSessionEntry(sessionId, entry);
    return true;
  }
  function getHealthSnapshot() {
    return {
      sessions: sessions.size,
      staleMappings: staleSessionMap.size,
      sessionDetails: Array.from(sessions.entries()).map(([id, entry]) => ({
        id: logSafeSessionId(id), age: now() - entry.createdAt, idle: now() - entry.lastAccess,
        initialized: entry.initialized, userAgent: entry.userAgent, clientInfo: entry.clientInfo
      }))
    };
  }

  async function cleanupIdleSessions() {
    const cutoff = now() - 3600000;
    const evicted = [];
    const closing = [];
    for (const [id, entry] of sessions) {
      if (entry.lastAccess < cutoff) {
        evicted.push({ sessionId: id, age_ms: now() - entry.createdAt, idle_ms: now() - entry.lastAccess, userAgent: entry.userAgent });
        closing.push(closeSessionEntry(id, entry));
      }
    }
    if (evicted.length > 0) logDebug("SESSION_CLEANUP", { evicted, remaining: sessions.size });
    await Promise.all(closing);
  }
  const sessionCleanup = setInterval(() => { cleanupIdleSessions().catch(() => {}); }, 600000);
  const staleCleanup = setInterval(() => {
    const cutoff = now() - 1800000;
    const evicted = [];
    for (const [staleId, entry] of staleSessionMap) {
      if (entry.createdAt < cutoff) {
        evicted.push({ staleSessionId: staleId, replacementId: entry.replacementId, age_ms: now() - entry.createdAt });
        staleSessionMap.delete(staleId);
      }
    }
    if (evicted.length > 0) logDebug("STALE_SESSION_CLEANUP", { evicted, remaining: staleSessionMap.size });
  }, 300000);

  async function dispose() {
    clearInterval(sessionCleanup);
    clearInterval(staleCleanup);
    await Promise.all(Array.from(sessions.entries()).map(([id, entry]) => closeSessionEntry(id, entry)));
    staleSessionMap.clear();
  }
  return { authorizeSessionIdentity, cleanupIdleSessions, deleteSession, dispose, getHealthSnapshot, getSession, getSessionCapacity, getTransportForRequest, hasSession, markSessionInitialized, registerSession };
}

module.exports = { createSessionManager };
