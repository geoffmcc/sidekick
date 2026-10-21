function registerEventRoutes({ app, platformKernel, authenticatedUser, requireIdentityPermission, auditLog, errorResponse }) {
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
    try {
      const subscription = platformKernel.registerEventSubscription({ ...req.body, source: "dashboard" });
      auditLog(req, "event_subscription.register", { subscription_id: subscription.subscription_id, event_type: subscription.event_type, actor });
      res.json({ ok: true, subscription });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "events" }); }
  });

  app.post("/api/event-subscriptions/:subscriptionId/:action", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor || !requireIdentityPermission(req, res, "events.manage")) return;
    const state = req.params.action === "pause" ? "paused" : req.params.action === "resume" ? "active" : null;
    if (!state) return res.status(404).json({ ok: false, error: "unknown subscription action" });
    try {
      const subscription = platformKernel.setEventSubscriptionState(req.params.subscriptionId, state);
      auditLog(req, `event_subscription.${req.params.action}`, { subscription_id: subscription.subscription_id, actor });
      res.json({ ok: true, subscription });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "events" }); }
  });

  app.post("/api/event-deliveries/:deliveryId/requeue", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor || !requireIdentityPermission(req, res, "events.manage")) return;
    try {
      const delivery = platformKernel.requeueEventDelivery(req.params.deliveryId);
      auditLog(req, "event_delivery.requeue", { delivery_id: delivery.delivery_id, actor });
      res.json({ ok: true, delivery });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "events" }); }
  });
}

module.exports = { registerEventRoutes };
