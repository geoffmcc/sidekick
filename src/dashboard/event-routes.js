function registerEventRoutes({ app, platformKernel, authenticatedUser, requireIdentityPermission, recordIdentityAudit, auditLog, errorResponse }) {
  function auditedMutation(req, res, { actorPrincipalId, eventType, auditAction, requestDetails, completionDetails, perform }) {
    if (!actorPrincipalId) return res.status(401).json({ ok: false, error: "authenticated principal required", code: "unauthenticated" });
    if (typeof recordIdentityAudit !== "function") return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "events" });
    try { auditLog(req, `${auditAction}.requested`, requestDetails); }
    catch { return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "events" }); }
    let identityAuditFailed = false;
    let result;
    try {
      result = perform(details => {
        try { recordIdentityAudit(eventType, null, actorPrincipalId, details); }
        catch (error) { identityAuditFailed = true; throw error; }
      });
    } catch (error) {
      if (identityAuditFailed) return errorResponse(req, res, null, { status: 503, code: "audit_unavailable", component: "events" });
      return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "events" });
    }
    let auditStatus = "complete";
    try { auditLog(req, auditAction, completionDetails(result)); }
    catch { auditStatus = "degraded"; }
    return res.json({ ok: true, ...result, audit_status: auditStatus });
  }

  app.get("/api/event-deliveries", (req, res) => {
    if (!requireIdentityPermission(req, res, "events.read")) return;
    try {
      const deliveries = platformKernel.listEventDeliveries({ subscription_id: req.query.subscription_id, status: req.query.status, limit: req.query.limit });
      res.json({ ok: true, subscriptions: platformKernel.listEventSubscriptions(), deliveries, total: deliveries.length, stats: platformKernel.getEventDeliveryStats() });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "events" }); }
  });

  app.post("/api/event-subscriptions", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor || !requireIdentityPermission(req, res, "events.manage")) return;
    const eventType = String(req.body?.event_type || "");
    return auditedMutation(req, res, {
      actorPrincipalId: req.authPrincipal?.principal_id,
      eventType: "dashboard.event_subscription.registered",
      auditAction: "event_subscription.register",
      requestDetails: { event_type: eventType },
      perform: audit => ({ subscription: platformKernel.registerEventSubscription({ ...req.body, source: "dashboard", audit }) }),
      completionDetails: ({ subscription }) => ({ subscription_id: subscription.subscription_id, event_type: subscription.event_type, actor }),
    });
  });

  app.post("/api/event-subscriptions/:subscriptionId/:action", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor || !requireIdentityPermission(req, res, "events.manage")) return;
    const state = req.params.action === "pause" ? "paused" : req.params.action === "resume" ? "active" : null;
    if (!state) return res.status(404).json({ ok: false, error: "unknown subscription action" });
    return auditedMutation(req, res, {
      actorPrincipalId: req.authPrincipal?.principal_id,
      eventType: `dashboard.event_subscription.${req.params.action}`,
      auditAction: `event_subscription.${req.params.action}`,
      requestDetails: { subscription_id: req.params.subscriptionId },
      perform: audit => ({ subscription: platformKernel.setEventSubscriptionState(req.params.subscriptionId, state, { audit }) }),
      completionDetails: ({ subscription }) => ({ subscription_id: subscription.subscription_id, actor }),
    });
  });

  app.post("/api/event-deliveries/:deliveryId/requeue", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor || !requireIdentityPermission(req, res, "events.manage")) return;
    return auditedMutation(req, res, {
      actorPrincipalId: req.authPrincipal?.principal_id,
      eventType: "dashboard.event_delivery.requeued",
      auditAction: "event_delivery.requeue",
      requestDetails: { delivery_id: req.params.deliveryId },
      perform: audit => ({ delivery: platformKernel.requeueEventDelivery(req.params.deliveryId, { audit }) }),
      completionDetails: ({ delivery }) => ({ delivery_id: delivery.delivery_id, actor }),
    });
  });
}

module.exports = { registerEventRoutes };
