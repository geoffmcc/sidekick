function registerEventRoutes({ app, platformKernel, authenticatedUser, auditLog }) {
  app.get("/api/event-deliveries", (req, res) => {
    try {
      const deliveries = platformKernel.listEventDeliveries({ subscription_id: req.query.subscription_id, status: req.query.status, limit: req.query.limit });
      res.json({ ok: true, subscriptions: platformKernel.listEventSubscriptions(), deliveries, total: deliveries.length, stats: platformKernel.getEventDeliveryStats() });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/event-subscriptions", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor) return res.status(403).json({ ok: false, error: "Connector and event operations require an authenticated dashboard user" });
    try {
      const subscription = platformKernel.registerEventSubscription({ ...req.body, source: "dashboard" });
      auditLog(req, "event_subscription.register", { subscription_id: subscription.subscription_id, event_type: subscription.event_type, actor });
      res.json({ ok: true, subscription });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/event-subscriptions/:subscriptionId/:action", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor) return res.status(403).json({ ok: false, error: "Event subscription operations require an authenticated dashboard user" });
    const state = req.params.action === "pause" ? "paused" : req.params.action === "resume" ? "active" : null;
    if (!state) return res.status(404).json({ ok: false, error: "unknown subscription action" });
    try {
      const subscription = platformKernel.setEventSubscriptionState(req.params.subscriptionId, state);
      auditLog(req, `event_subscription.${req.params.action}`, { subscription_id: subscription.subscription_id, actor });
      res.json({ ok: true, subscription });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/event-deliveries/:deliveryId/requeue", (req, res) => {
    const actor = authenticatedUser(req);
    if (!actor) return res.status(403).json({ ok: false, error: "Delivery operations require an authenticated dashboard user" });
    try {
      const delivery = platformKernel.requeueEventDelivery(req.params.deliveryId);
      auditLog(req, "event_delivery.requeue", { delivery_id: delivery.delivery_id, actor });
      res.json({ ok: true, delivery });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
}

module.exports = { registerEventRoutes };
