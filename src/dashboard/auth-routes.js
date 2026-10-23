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
  bootstrapToken,
  remoteBootstrapAllowed = false,
  errorResponse,
}) {
  app.get("/api/auth/bootstrap-status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ bootstrap_required: !bootstrapCompleted() });
  });

  app.post("/api/auth/bootstrap", (req, res) => {
    try {
      if (bootstrapCompleted()) return errorResponse(req, res, null, { status: 409, code: "conflict", component: "auth" });
      if (remoteBootstrapAllowed && (!bootstrapToken || !timingSafeCompare(req.body?.bootstrap_token, bootstrapToken))) {
        return errorResponse(req, res, null, { status: 403, code: "forbidden", component: "auth" });
      }
      const principal = identity.bootstrapOwner(req.body || {});
      const session = authentication.createSession(principal.principal_id, {
        userAgent: req.headers["user-agent"] || null,
        ipAddress: req.ip || null,
      });
      setIdentityCookie(res, session.token, undefined, req);
      res.status(201).json({ principal, expires_at: session.expires_at });
    } catch (error) {
      return errorResponse(req, res, error, { status: /already|completed/i.test(String(error?.message || "")) ? 409 : 400, code: /already|completed/i.test(String(error?.message || "")) ? "conflict" : "invalid_request", component: "auth" });
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
    try { authentication.invalidateSession(token, req.authPrincipal?.principal_id || null); }
    catch { clearIdentityCookie(res, req); return res.status(503).json({ error: "Session audit storage is unavailable", code: "audit_unavailable" }); }
    clearIdentityCookie(res, req);
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
        const principal = legacyDashboardPrincipal(user, pass);
        if (!principal?.principal_id) return res.status(503).json({ error: "Dashboard identity is unavailable", code: "identity_unavailable" });
        const session = authentication.createSession(principal.principal_id, {
          userAgent: req.headers["user-agent"] || null,
          ipAddress: req.ip || null,
        });
        setIdentityCookie(res, session.token, undefined, req);
        req.authUser = user;
        req.authPrincipal = { ...principal, ...authentication.getSession(session.token) };
        req.authPrincipalId = principal.principal_id;
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

  function identityPermissionDecision(req, permission) {
    const principalId = req.authPrincipal?.principal_id;
    const principal = req.authPrincipal;
    return authorization.authorize({
      principalId,
      permission,
      ...(Array.isArray(principal?.scopes) ? { credentialScopes: principal.scopes } : {}),
      delegationId: principal?.delegation_id || null,
    });
  }

  function hasIdentityPermission(req, permission) {
    const principal = req.authPrincipal;
    if (principal?.session_id && (!authentication || typeof authentication.isSessionActive !== "function" || !authentication.isSessionActive(principal.session_id))) return false;
    return identityPermissionDecision(req, permission).ok;
  }

  function requireIdentityPermission(req, res, permission) {
    const decision = identityPermissionDecision(req, permission);
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
      authentication.invalidatePrincipalSessions(principalId, principalId);
      res.json({ ok: true });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "auth" });
    }
  });

  app.post("/api/auth/users", (req, res) => {
    if (!requireIdentityAdministrator(req, res)) return;
    // Creating an account and assigning it a role are separate authorities.
    // In particular, users.manage must not become an indirect path to the
    // critical roles.manage operation through this convenience endpoint.
    if (req.body?.role && !requireIdentityPermission(req, res, "roles.manage")) return;
    try {
      const principal = identity.createHumanUser({ username: req.body?.username, password: req.body?.password, displayName: req.body?.display_name, actorPrincipalId: req.authPrincipal.principal_id });
      if (req.body?.role) identity.assignRole(principal.principal_id, req.body.role, req.authPrincipal.principal_id);
      res.status(201).json({ principal: identity.getPrincipal(principal.principal_id) });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "user_create_failed", component: "auth" });
    }
  });

  app.post("/api/auth/users/:id/password-reset", (req, res) => {
    if (!requireIdentityAdministrator(req, res)) return;
    try {
      const target = identity.getHumanUser(req.params.id);
      if (!target) return res.status(404).json({ error: "Human principal not found" });
      identity.changePassword(target.principal.principal_id, req.body?.new_password, req.authPrincipal.principal_id);
      authentication.invalidatePrincipalSessions(target.principal.principal_id, req.authPrincipal.principal_id);
      res.json({ ok: true });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "auth" });
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
      if (req.params.state === 'disable') authentication.invalidatePrincipalSessions(principal.principal_id, req.authPrincipal.principal_id);
      res.json({ principal });
    } catch (error) {
      return errorResponse(req, res, error, { status: String(error?.message || "").includes("Owner") ? 409 : 400, code: "principal_state_change_rejected", component: "auth" });
    }
  }

  app.post("/api/auth/principals/:id/enable", (req, res) => { req.params.state = 'enable'; setPrincipalStateRoute(req, res); });
  app.post("/api/auth/principals/:id/disable", (req, res) => { req.params.state = 'disable'; setPrincipalStateRoute(req, res); });

  app.post("/api/auth/principals/:id/roles", (req, res) => {
    const adoptedSelfPromotion = req.body?.role === "owner" && req.params.id === req.authPrincipal?.principal_id &&
      req.authPrincipal?.principal_type === "human" && req.authPrincipal?.metadata?.adopted_legacy_dashboard === true &&
      identity.canCompleteFirstOwnerSetup?.(req.params.id) === true;
    if (!adoptedSelfPromotion && !requireIdentityPermission(req, res, "roles.manage")) return;
    try {
      res.status(201).json({ principal: identity.assignRole(req.params.id, req.body?.role, req.authPrincipal.principal_id) });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "auth" });
    }
  });

  app.delete("/api/auth/principals/:id/roles/:role", (req, res) => {
    if (!requireIdentityPermission(req, res, "roles.manage")) return;
    try {
      res.json({ principal: identity.removeRole(req.params.id, req.params.role, req.authPrincipal.principal_id) });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "auth" });
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
    const principal = req.authPrincipal;
    const authorizeRequest = permission => authorization.authorize({
      principalId: principal?.principal_id,
      permission,
      ...(Array.isArray(principal?.scopes) ? { credentialScopes: principal.scopes } : {}),
      delegationId: principal?.delegation_id || null,
    });
    const isDelegator = Boolean(principal?.principal_id && delegatorPrincipalId === principal.principal_id);
    if (!principal || (!isDelegator && !authorizeRequest("principals.manage").ok)) {
      return res.status(403).json({ error: "Delegation must be created by the delegator or an authorized administrator", code: "insufficient_delegation" });
    }
    // A principal delegating its own authority must not use a broad role grant
    // to escape the narrower credential/delegation context of this request.
    if (isDelegator) {
      const requested = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
      if (requested.some(permission => !authorizeRequest(permission).ok)) {
        return res.status(403).json({ error: "Delegation exceeds the request authority", code: "insufficient_delegation" });
      }
    }
    try {
      const delegation = authorization.createDelegation({ delegatorPrincipalId, delegatePrincipalId: req.body?.delegate_principal_id, permissions: req.body?.permissions, expiresAt: req.body?.expires_at, actorPrincipalId: req.authPrincipal.principal_id });
      res.status(201).json({ delegation });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "auth" });
    }
  });

  app.post("/api/auth/delegations/:id/revoke", (req, res) => {
    const principal = req.authPrincipal;
    if (!principal?.principal_id) return res.status(401).json({ error: "Authentication required", code: "unauthenticated" });
    const delegation = authorization.getDelegation(req.params.id);
    if (!delegation) return res.status(404).json({ error: "Delegation not found", code: "not_found" });
    if (delegation.delegator_principal_id !== principal.principal_id && !authorization.authorize({
      principalId: principal.principal_id,
      permission: "principals.manage",
      ...(Array.isArray(principal.scopes) ? { credentialScopes: principal.scopes } : {}),
      delegationId: principal.delegation_id || null,
    }).ok) {
      return res.status(403).json({ error: "Delegation revocation exceeds the request authority", code: "insufficient_delegation" });
    }
    try {
      res.json({ delegation: authorization.revokeDelegation(req.params.id, principal.principal_id) });
    } catch (error) {
      return errorResponse(req, res, error, { status: 403, code: "insufficient_delegation", component: "auth" });
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
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "auth" });
    }
  });

  // Provision a narrowly scoped machine identity in one atomic operation.
  // Direct permission grants are restricted to service principals, and each
  // grant is checked against the initiating human's current authority.
  app.post("/api/auth/service-credentials", (req, res) => {
    if (!requireIdentityPermission(req, res, "principals.manage")) return;
    if (!requireIdentityPermission(req, res, "roles.manage")) return;
    if (!requireIdentityPermission(req, res, "credentials.create")) return;
    const permissions = req.body?.permissions;
    const scopes = req.body?.scopes === undefined ? permissions : req.body.scopes;
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some(value => typeof value !== "string") ||
        !Array.isArray(scopes) || scopes.length === 0 || scopes.some(value => typeof value !== "string")) {
      return res.status(400).json({ error: "permissions and scopes must be non-empty permission arrays", code: "invalid_request" });
    }
    const uniquePermissions = [...new Set(permissions.map(value => value.trim()))];
    const uniqueScopes = [...new Set(scopes.map(value => value.trim()))];
    if (!uniquePermissions.every(Boolean) || !uniqueScopes.every(Boolean) || uniqueScopes.some(scope => !uniquePermissions.includes(scope))) {
      return res.status(400).json({ error: "credential scopes must be a subset of granted permissions", code: "invalid_request" });
    }
    const actorId = req.authPrincipal.principal_id;
    const actor = req.authPrincipal;
    for (const permission of uniquePermissions) {
      const decision = authorization.authorize({
        principalId: actorId,
        permission,
        ...(Array.isArray(actor.scopes) ? { credentialScopes: actor.scopes } : {}),
        delegationId: actor.delegation_id || null,
      });
      if (!decision.ok) return res.status(403).json({ error: "Cannot grant a permission the initiating identity does not hold", code: "forbidden", permission });
    }
    try {
      const db = dbStore.getDb();
      let provisioned;
      db.transaction(() => {
        let principal;
        if (req.body?.principal_id) {
          principal = identity.getPrincipal(req.body.principal_id);
          if (!principal || principal.principal_type !== "service" || !principal.enabled || principal.metadata?.managed_for !== "scoped_machine_credential") {
            throw new Error("enabled managed service principal not found");
          }
          const granted = new Set(identity.getPrincipalPermissions(principal.principal_id));
          if (uniquePermissions.some(permission => !granted.has(permission))) throw new Error("credential permissions exceed the service principal grants");
        } else {
          principal = identity.createPrincipal({
            type: "service",
            displayName: req.body?.display_name,
            createdByPrincipalId: actorId,
            actorPrincipalId: actorId,
            metadata: { managed_for: "scoped_machine_credential" },
          });
          for (const permission of uniquePermissions) identity.grantPrincipalPermission(principal.principal_id, permission, actor);
        }
        const created = authentication.createCredential({
          principalId: principal.principal_id,
          displayName: req.body?.credential_name || req.body?.display_name,
          scopes: uniqueScopes,
          expiresAt: req.body?.expires_at,
          createdByPrincipalId: actorId,
        });
        provisioned = { principal, credential: created.credential, token: created.token };
      })();
      res.set("Cache-Control", "no-store");
      res.status(201).json(provisioned);
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "service_credential_create_failed", component: "auth" });
    }
  });

  app.get("/api/auth/service-credentials", (req, res) => {
    if (!requireIdentityPermission(req, res, "principals.read")) return;
    if (!requireIdentityPermission(req, res, "credentials.read")) return;
    const managed = identity.listPrincipals({ type: "service" })
      .filter(principal => principal.metadata?.managed_for === "scoped_machine_credential")
      .map(principal => ({
        principal_id: principal.principal_id,
        display_name: principal.display_name,
        enabled: principal.enabled,
        permissions: identity.getPrincipalPermissions(principal.principal_id),
        credentials: authentication.listCredentials(principal.principal_id),
      }));
    res.set("Cache-Control", "no-store");
    res.json({ service_principals: managed });
  });

  app.post("/api/auth/service-credentials/:id/rotate", (req, res) => {
    if (!requireIdentityPermission(req, res, "credentials.revoke")) return;
    if (!requireIdentityPermission(req, res, "roles.manage")) return;
    const credential = authentication.getCredential(req.params.id);
    const principal = credential && identity.getPrincipal(credential.principal_id);
    if (!principal || principal.principal_type !== "service" || principal.metadata?.managed_for !== "scoped_machine_credential") {
      return res.status(404).json({ error: "Managed service credential not found", code: "not_found" });
    }
    for (const scope of credential.scopes) {
      const decision = authorization.authorize({
        principalId: req.authPrincipal.principal_id,
        permission: scope,
        ...(Array.isArray(req.authPrincipal.scopes) ? { credentialScopes: req.authPrincipal.scopes } : {}),
        delegationId: req.authPrincipal.delegation_id || null,
      });
      if (!decision.ok) return res.status(403).json({ error: "Cannot rotate a credential beyond the initiating identity's authority", code: "forbidden", permission: scope });
    }
    try {
      const replacement = authentication.rotateCredential(credential.credential_id, req.authPrincipal.principal_id);
      res.set("Cache-Control", "no-store");
      res.status(201).json({ principal, credential: replacement.credential, token: replacement.token });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "service_credential_rotation_failed", component: "auth" });
    }
  });

  app.post("/api/auth/credentials/:id/revoke", (req, res) => {
    if (!requireIdentityPermission(req, res, "credentials.revoke")) return;
    res.json({ revoked: authentication.revokeCredential(req.params.id, req.authPrincipal?.principal_id || null) });
  });

  app.post("/api/auth/credentials/:id/rotate", (req, res) => {
    if (!requireIdentityPermission(req, res, "credentials.revoke")) return;
    try {
      const replacement = authentication.rotateCredential(req.params.id, req.authPrincipal.principal_id);
      res.status(201).json({ credential: replacement.credential, token: replacement.token });
    } catch (error) {
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "auth" });
    }
  });

  return { requireIdentityPermission, hasIdentityPermission, requireIdentityAdministrator };
}

module.exports = { registerAuthRoutes };
