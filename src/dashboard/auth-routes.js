/**
 * Dashboard identity, authentication, principal, role, delegation, and
 * credential routes.
 *
 * The dashboard bootstrap owns the Express application and shared security
 * helpers. This module owns the HTTP surface for identity operations and
 * receives those helpers explicitly so authorization remains centralized.
 */
function registerAuthRoutes({
  app,
  dbStore,
  identity,
  authentication,
  authorization,
  timingSafeCompare,
  dashboardUser,
  dashboardPass,
  bootstrapCompleted,
  authAttemptKeys,
  rejectIfAuthThrottled,
  recordAuthFailure,
  clearAuthFailures,
  legacyDashboardPrincipal,
  setIdentityCookie,
  clearIdentityCookie,
  requestCookie,
  verifySessionToken,
  makeSessionToken,
}) {
  app.get("/api/auth/bootstrap-status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ bootstrap_required: !bootstrapCompleted() });
  });

  app.post("/api/auth/bootstrap", (req, res) => {
    try {
      if (bootstrapCompleted()) return res.status(409).json({ error: "Owner bootstrap has already been completed" });
      const principal = identity.bootstrapOwner(req.body || {});
      const session = authentication.createSession(principal.principal_id, {
        userAgent: req.headers["user-agent"] || null,
        ipAddress: req.ip || null,
      });
      setIdentityCookie(res, session.token, undefined, req);
      res.status(201).json({ principal, expires_at: session.expires_at });
    } catch (error) {
      res.status(/already|completed/i.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const username = req.body?.username;
    const attemptKeys = authAttemptKeys(req, username);
    if (rejectIfAuthThrottled(req, res, attemptKeys)) return;
    let principal = identity.verifyUserPassword(username, req.body?.password);
    if (!principal && dashboardUser && dashboardPass && timingSafeCompare(username, dashboardUser) && timingSafeCompare(req.body?.password, dashboardPass)) {
      principal = legacyDashboardPrincipal(dashboardUser, dashboardPass);
    }
    if (!principal) {
      recordAuthFailure(req, attemptKeys);
      return res.status(401).json({ error: "Invalid username or password" });
    }
    clearAuthFailures(attemptKeys);
    const session = authentication.createSession(principal.principal_id, {
      userAgent: req.headers["user-agent"] || null,
      ipAddress: req.ip || null,
    });
    setIdentityCookie(res, session.token, undefined, req);
    res.set("Cache-Control", "no-store");
    res.json({ principal, expires_at: session.expires_at });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = requestCookie(req, "sidekick_identity");
    authentication.invalidateSession(token);
    clearIdentityCookie(res);
    res.status(204).end();
  });

  if ((dashboardUser && dashboardPass) || bootstrapCompleted()) {
    app.use((req, res, next) => {
      if (req.path.startsWith('/static/')) return next();
      const identityToken = requestCookie(req, "sidekick_identity");
      const identitySession = authentication.getSession(identityToken);
      if (identitySession) {
        const principal = identity.getPrincipal(identitySession.principal_id);
        if (!principal || !principal.enabled) return res.status(401).json({ error: "Authentication required", code: "principal-disabled" });
        req.authPrincipal = { ...identitySession, ...principal };
        req.authPrincipalId = identitySession.principal_id;
        req.authUser = identitySession.display_name;
        return next();
      }
      if (!dashboardUser || !dashboardPass) {
        return res.status(401).json({ error: "Authentication required", code: "unauthenticated" });
      }
      const cookie = req.headers.cookie || "";
      for (const part of cookie.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith("sidekick_sid=")) {
          const user = verifySessionToken(trimmed.slice("sidekick_sid=".length));
          if (user === dashboardUser) {
            req.authUser = user;
            req.authPrincipal = legacyDashboardPrincipal(user, dashboardPass);
            req.authPrincipalId = req.authPrincipal?.principal_id || null;
            return next();
          }
        }
      }
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Basic ")) {
        res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
        return res.status(401).send("Authentication required");
      }
      const decoded = Buffer.from(auth.slice(6), "base64").toString();
      const separator = decoded.indexOf(":");
      const user = separator >= 0 ? decoded.slice(0, separator) : "";
      const pass = separator >= 0 ? decoded.slice(separator + 1) : "";
      const attemptKeys = authAttemptKeys(req, user);
      if (rejectIfAuthThrottled(req, res, attemptKeys)) return;
      if (timingSafeCompare(user, dashboardUser) && timingSafeCompare(pass, dashboardPass)) {
        const secure = Boolean(req.secure);
        res.setHeader("Set-Cookie", `sidekick_sid=${makeSessionToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure ? "; Secure" : ""}`);
        req.authUser = user;
        req.authPrincipal = legacyDashboardPrincipal(user, pass);
        req.authPrincipalId = req.authPrincipal?.principal_id || null;
        clearAuthFailures(attemptKeys);
        return next();
      }
      recordAuthFailure(req, attemptKeys);
      res.set("WWW-Authenticate", 'Basic realm="Sidekick Dashboard"');
      res.status(401).send("Authentication required");
    });
  } else {
    app.use((req, res, next) => {
      if (req.path.startsWith("/static/") || ["/api/auth/bootstrap-status", "/api/auth/bootstrap", "/api/auth/login", "/api/auth/logout"].includes(req.path)) return next();
      res.status(503).json({ error: "Owner bootstrap required", code: "bootstrap-required" });
    });
  }

  function requireIdentityPermission(req, res, permission) {
    const principalId = req.authPrincipal?.principal_id;
    const decision = authorization.authorize({ principalId, permission });
    if (!decision.ok) {
      res.status(decision.code === "unauthenticated" ? 401 : 403).json({ error: "Forbidden", code: decision.code, permission });
      return false;
    }
    return true;
  }

  function requireIdentityAdministrator(req, res) {
    return requireIdentityPermission(req, res, "users.manage");
  }

  app.get("/api/auth/me", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ principal: req.authPrincipal || null, legacy: !req.authPrincipal && Boolean(req.authUser) });
  });

  app.post("/api/auth/password", (req, res) => {
    const principalId = req.authPrincipal?.principal_id;
    const account = principalId ? identity.getHumanUser(principalId) : null;
    if (!account) return res.status(403).json({ error: "A local identity session is required", code: "insufficient_identity" });
    if (!identity.verifyUserPassword(account.username, req.body?.current_password)) return res.status(401).json({ error: "Current password is incorrect" });
    try {
      identity.changePassword(principalId, req.body?.new_password, principalId);
      authentication.invalidatePrincipalSessions(principalId);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/users", (req, res) => {
    if (!requireIdentityAdministrator(req, res)) return;
    try {
      const principal = identity.createHumanUser({ username: req.body?.username, password: req.body?.password, displayName: req.body?.display_name, actorPrincipalId: req.authPrincipal.principal_id });
      if (req.body?.role) identity.assignRole(principal.principal_id, req.body.role, req.authPrincipal.principal_id);
      res.status(201).json({ principal: identity.getPrincipal(principal.principal_id) });
    } catch (error) {
      res.status(400).json({ error: error.message, code: 'user_create_failed' });
    }
  });

  app.post("/api/auth/users/:id/password-reset", (req, res) => {
    if (!requireIdentityAdministrator(req, res)) return;
    try {
      const target = identity.getHumanUser(req.params.id);
      if (!target) return res.status(404).json({ error: "Human principal not found" });
      identity.changePassword(target.principal.principal_id, req.body?.new_password, req.authPrincipal.principal_id);
      authentication.invalidatePrincipalSessions(target.principal.principal_id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/auth/principals", (req, res) => {
    if (!requireIdentityPermission(req, res, "principals.read")) return;
    res.set("Cache-Control", "no-store");
    res.json({ principals: identity.listPrincipals({ type: req.query.type, enabled: req.query.enabled === undefined ? undefined : req.query.enabled !== "false", limit: req.query.limit }) });
  });

  function setPrincipalStateRoute(req, res) {
    if (!requireIdentityPermission(req, res, "principals.manage")) return;
    if (!['enable', 'disable'].includes(req.params.state)) return res.status(404).json({ error: "Unknown principal state" });
    try {
      const principal = identity.setPrincipalEnabled(req.params.id, req.params.state === 'enable', req.authPrincipal.principal_id);
      if (req.params.state === 'disable') authentication.invalidatePrincipalSessions(principal.principal_id);
      res.json({ principal });
    } catch (error) {
      res.status(error.message.includes('Owner') ? 409 : 400).json({ error: error.message, code: 'principal_state_change_rejected' });
    }
  }

  app.post("/api/auth/principals/:id/enable", (req, res) => { req.params.state = 'enable'; setPrincipalStateRoute(req, res); });
  app.post("/api/auth/principals/:id/disable", (req, res) => { req.params.state = 'disable'; setPrincipalStateRoute(req, res); });

  app.post("/api/auth/principals/:id/roles", (req, res) => {
    const adoptedSelfPromotion = req.body?.role === "owner" && req.params.id === req.authPrincipal?.principal_id && req.authPrincipal?.principal_type === "human" && req.authPrincipal?.metadata?.adopted_legacy_dashboard === true;
    if (!adoptedSelfPromotion && !requireIdentityPermission(req, res, "roles.manage")) return;
    try {
      res.status(201).json({ principal: identity.assignRole(req.params.id, req.body?.role, req.authPrincipal.principal_id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/auth/principals/:id/roles/:role", (req, res) => {
    if (!requireIdentityPermission(req, res, "roles.manage")) return;
    try {
      res.json({ principal: identity.removeRole(req.params.id, req.params.role, req.authPrincipal.principal_id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/auth/delegations", (req, res) => {
    if (!requireIdentityPermission(req, res, "principals.read")) return;
    const rows = dbStore.getDb().prepare("SELECT delegation_id FROM identity_delegations WHERE delegate_principal_id = ? OR delegator_principal_id = ? ORDER BY created_at DESC LIMIT ?").all(req.authPrincipal.principal_id, req.authPrincipal.principal_id, Math.max(1, Math.min(Number(req.query.limit) || 100, 500)));
    res.set("Cache-Control", "no-store");
    res.json({ delegations: rows.map(row => authorization.getDelegation(row.delegation_id)) });
  });

  app.post("/api/auth/delegations", (req, res) => {
    const delegatorPrincipalId = req.body?.delegator_principal_id;
    if (!req.authPrincipal || (delegatorPrincipalId !== req.authPrincipal.principal_id && !authorization.authorize({ principalId: req.authPrincipal.principal_id, permission: "principals.manage" }).ok)) {
      return res.status(403).json({ error: "Delegation must be created by the delegator or an authorized administrator", code: "insufficient_delegation" });
    }
    try {
      const delegation = authorization.createDelegation({ delegatorPrincipalId, delegatePrincipalId: req.body?.delegate_principal_id, permissions: req.body?.permissions, expiresAt: req.body?.expires_at, actorPrincipalId: req.authPrincipal.principal_id });
      res.status(201).json({ delegation });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/delegations/:id/revoke", (req, res) => {
    if (!req.authPrincipal) return res.status(401).json({ error: "Authentication required", code: "unauthenticated" });
    try {
      res.json({ delegation: authorization.revokeDelegation(req.params.id, req.authPrincipal.principal_id) });
    } catch (error) {
      res.status(403).json({ error: error.message, code: "insufficient_delegation" });
    }
  });

  app.get("/api/auth/credentials", (req, res) => {
    if (!requireIdentityPermission(req, res, "credentials.read")) return;
    res.set("Cache-Control", "no-store");
    res.json({ credentials: authentication.listCredentials(req.query.principal_id || null) });
  });

  app.post("/api/auth/credentials", (req, res) => {
    if (!requireIdentityPermission(req, res, "credentials.create")) return;
    try {
      const created = authentication.createCredential({ principalId: req.body?.principal_id, displayName: req.body?.display_name, scopes: req.body?.scopes, expiresAt: req.body?.expires_at, createdByPrincipalId: req.authPrincipal.principal_id });
      res.status(201).json({ credential: created.credential, token: created.token });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/credentials/:id/revoke", (req, res) => {
    if (!requireIdentityPermission(req, res, "credentials.revoke")) return;
    res.json({ revoked: authentication.revokeCredential(req.params.id) });
  });

  app.post("/api/auth/credentials/:id/rotate", (req, res) => {
    if (!requireIdentityPermission(req, res, "credentials.revoke")) return;
    try {
      const replacement = authentication.rotateCredential(req.params.id, req.authPrincipal.principal_id);
      res.status(201).json({ credential: replacement.credential, token: replacement.token });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return { requireIdentityPermission, requireIdentityAdministrator };
}

module.exports = { registerAuthRoutes };
