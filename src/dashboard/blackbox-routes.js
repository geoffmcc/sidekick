"use strict";

function registerBlackboxRoutes({ app, blackbox, requireIdentityPermission, blackboxJson, governedDashboardMutation }) {
  app.get("/api/blackbox/profiles", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    res.json({ profiles: blackbox.PROFILE_INFO });
  });

  app.get("/api/blackbox/health", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => blackbox.blackboxHealth());
  });

  app.get("/api/blackbox/storage", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => blackbox.storageStatus());
  });

  app.get("/api/blackbox/incidents", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => ({ incidents: blackbox.listIncidents(req.query) }));
  });

  app.post("/api/blackbox/capture", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "capture", ...(req.body || {}) }, "blackbox.capture"));

  app.get("/api/blackbox/incidents/:id", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => {
      const incident = blackbox.getIncident(req.params.id, { includeTimeline: true, includeAnalysis: true });
      if (!incident) {
        res.status(404);
        return { error: "Incident not found" };
      }
      return { incident };
    });
  });

  app.patch("/api/blackbox/incidents/:id", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "update_incident", incident_id: req.params.id, ...(req.body || {}) }, "blackbox.update"));
  app.delete("/api/blackbox/incidents/:id", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "delete", incident_id: req.params.id }, "blackbox.delete"));

  app.get("/api/blackbox/incidents/:id/timeline", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => ({ timeline: blackbox.getTimeline(req.params.id) }));
  });

  app.get("/api/blackbox/incidents/:id/export", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => ({ export: blackbox.exportIncident(req.params.id, { format: req.query.format || "json" }) }));
  });

  app.post("/api/blackbox/incidents/:id/analyze", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "analyze", incident_id: req.params.id, ...(req.body || {}) }, "blackbox.analyze"));
  app.post("/api/blackbox/incidents/:id/notes", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "add_note", incident_id: req.params.id, ...(req.body || {}) }, "blackbox.note"));

  app.get("/api/blackbox/captures/:id", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => ({ capture: blackbox.getCapture(req.params.id, { includeSources: true }) }));
  });

  app.post("/api/blackbox/captures/:id/cancel", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "cancel_capture", capture_id: req.params.id }, "blackbox.cancel"));
  app.post("/api/blackbox/captures/:id/retry", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "retry_capture", capture_id: req.params.id, ...(req.body || {}) }, "blackbox.retry"));
  app.post("/api/blackbox/captures/:id/repair", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "repair", capture_id: req.params.id }, "blackbox.repair"));

  app.get("/api/blackbox/captures/:id/stream", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(blackbox.captureStatus(req.params.id))}\n\n`);
    const unsubscribe = blackbox.subscribeCapture(req.params.id, event => {
      res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
    });
    req.on("close", unsubscribe);
  });

  app.get("/api/blackbox/sources/:id", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => ({ source: blackbox.getSource(req.params.id, { offset: Number(req.query.offset || 0), limit: Number(req.query.limit || 65536) }) }));
  });

  app.get("/api/blackbox/search", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => ({ results: blackbox.searchIncidents(req.query.q || req.query.query || "", req.query) }));
  });

  app.get("/api/blackbox/compare", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => blackbox.compareCaptures(req.query.a, req.query.b));
  });

  app.get("/api/blackbox/purge-preview", (req, res) => {
    if (!requireIdentityPermission(req, res, "blackbox.read")) return;
    return blackboxJson(res, () => blackbox.purgePreview());
  });

  app.post("/api/blackbox/purge", (req, res) => governedDashboardMutation(req, res, "black_box", { action: "purge", confirm: req.body?.confirm === true }, "blackbox.purge"));
}

module.exports = { registerBlackboxRoutes };
