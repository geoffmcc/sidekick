const { WebStandardStreamableHTTPServerTransport } = require("@modelcontextprotocol/server");

function createSessionManager({ createMcpServer, logDebug, now = () => Date.now(), sessionIdGenerator } = {}) {
  const sessions = new Map();
  const staleSessionMap = new Map();
  const generateSessionId = sessionIdGenerator || (() => "sess-" + now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));

  function registerSession(sessionId, server, transport, metadata = {}) {
    logDebug("REGISTER_SESSION", { sessionId, sessionCount: sessions.size + 1, userAgent: metadata.userAgent, clientInfo: metadata.clientInfo });
    sessions.set(sessionId, {
      server,
      transport,
      createdAt: now(),
      lastAccess: now(),
      initialized: false,
      userAgent: metadata.userAgent || null,
      clientInfo: metadata.clientInfo || null,
      authIdentity: metadata.authIdentity || null,
      authState: metadata.authState || { current: metadata.authIdentity || null }
    });
  }

  function markSessionInitialized(sessionId) {
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.initialized = true;
      logDebug("SESSION_INITIALIZED", { sessionId });
    }
  }

  async function getTransportForRequest(sessionId, metadata = {}, options = {}) {
    logDebug("getTransportForRequest", { requestedSessionId: sessionId, sessionCount: sessions.size });
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId);
      if (metadata.authIdentity !== undefined && entry.authState) entry.authState.current = metadata.authIdentity;
      const age = now() - entry.createdAt;
      const idle = now() - entry.lastAccess;
      entry.lastAccess = now();
      logDebug("REUSE_SESSION", { sessionId, age_ms: age, idle_ms: idle });
      return { transport: entry.transport, isNew: false };
    }

    if (sessionId && !sessions.has(sessionId)) {
      const staleEntry = staleSessionMap.get(sessionId);
      const replacementId = staleEntry?.replacementId;
      if (replacementId && sessions.has(replacementId)) {
        logDebug("STALE_SESSION_KNOWN_REPLACEMENT", { staleSessionId: sessionId, replacementId });
        if (options.allowStalePost) {
          const entry = sessions.get(replacementId);
          if (metadata.authIdentity !== undefined && entry.authState) entry.authState.current = metadata.authIdentity;
          entry.lastAccess = now();
          return { transport: entry.transport, isNew: false, newSessionId: replacementId, staleRedirect: false, replacedStaleSession: true };
        }
        return { transport: null, isNew: false, newSessionId: replacementId, staleRedirect: true };
      }

      logDebug("STALE_SESSION_CREATING_REPLACEMENT", { staleSessionId: sessionId, sessionCount: sessions.size });
      const newSessionId = generateSessionId();
      const authState = { current: metadata.authIdentity || null };
      const server = createMcpServer(() => authState.current);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId, enableJsonResponse: true });
      registerSession(newSessionId, server, transport, { ...metadata, authState });
      await server.connect(transport);
      staleSessionMap.set(sessionId, { replacementId: newSessionId, createdAt: now() });
      if (staleSessionMap.size > 100) staleSessionMap.delete(staleSessionMap.keys().next().value);
      logDebug("CREATED_REPLACEMENT_SESSION", { staleSessionId: sessionId, newSessionId });
      if (options.allowStalePost) return { transport, isNew: true, newSessionId, staleRedirect: false, replacedStaleSession: true };
      return { transport: null, isNew: true, newSessionId, staleRedirect: true };
    }

    const newSessionId = generateSessionId();
    const authState = { current: metadata.authIdentity || null };
    const server = createMcpServer(() => authState.current);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId, enableJsonResponse: true });
    registerSession(newSessionId, server, transport, { ...metadata, authState });
    await server.connect(transport);
    logDebug("CREATED_NEW_TRANSPORT", { newSessionId });
    return { transport, isNew: true, newSessionId };
  }

  function getSession(sessionId) { return sessions.get(sessionId); }
  function hasSession(sessionId) { return sessions.has(sessionId); }
  function deleteSession(sessionId) { return sessions.delete(sessionId); }
  function getHealthSnapshot() {
    return {
      sessions: sessions.size,
      staleMappings: staleSessionMap.size,
      sessionDetails: Array.from(sessions.entries()).map(([id, entry]) => ({
        id, age: now() - entry.createdAt, idle: now() - entry.lastAccess,
        initialized: entry.initialized, userAgent: entry.userAgent, clientInfo: entry.clientInfo
      }))
    };
  }

  const sessionCleanup = setInterval(() => {
    const cutoff = now() - 3600000;
    const evicted = [];
    for (const [id, entry] of sessions) {
      if (entry.lastAccess < cutoff) {
        evicted.push({ sessionId: id, age_ms: now() - entry.createdAt, idle_ms: now() - entry.lastAccess, userAgent: entry.userAgent });
        sessions.delete(id);
      }
    }
    if (evicted.length > 0) logDebug("SESSION_CLEANUP", { evicted, remaining: sessions.size });
  }, 600000);
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

  function dispose() { clearInterval(sessionCleanup); clearInterval(staleCleanup); }
  return { deleteSession, dispose, getHealthSnapshot, getSession, getTransportForRequest, hasSession, markSessionInitialized, registerSession };
}

module.exports = { createSessionManager };
