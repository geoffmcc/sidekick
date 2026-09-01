"use strict";

function registerCapabilityRoutes({ app, capabilityAction, capabilityResult, callDashboardTool, dashboardExecutionMetadata, authenticatedUser, logError }) {
  app.get("/api/capabilities", (req, res) => capabilityAction(req, res, { action: "list" }, "list"));

  app.get("/api/capabilities/:name", (req, res) =>
    capabilityAction(req, res, { action: "show", name: req.params.name }, "show"));

  app.get("/api/capabilities/:name/health", (req, res) =>
    capabilityAction(req, res, { action: "health", name: req.params.name }, "health"));

  app.post("/api/capabilities/inspect", (req, res) =>
    capabilityAction(req, res, { action: "inspect", name: req.body?.name, path: req.body?.path }, "inspect"));

  app.post("/api/capabilities/install", (req, res) =>
    capabilityAction(req, res, {
      action: "install",
      name: req.body?.name,
      path: req.body?.path,
      config: req.body?.config,
      enable: req.body?.enable === true,
    }, "install"));

  app.post("/api/capabilities/:name/configure", (req, res) =>
    capabilityAction(req, res, { action: "configure", name: req.params.name, config: req.body?.config || {} }, "configure"));

  app.post("/api/capabilities/:name/enable", (req, res) =>
    capabilityAction(req, res, { action: "enable", name: req.params.name }, "enable"));

  app.post("/api/capabilities/:name/disable", (req, res) =>
    capabilityAction(req, res, { action: "disable", name: req.params.name }, "disable"));

  app.post("/api/capabilities/:name/upgrade", (req, res) =>
    capabilityAction(req, res, {
      action: "upgrade",
      name: req.params.name,
      path: req.body?.path,
      allow_same_version: req.body?.allow_same_version === true,
      allow_downgrade: req.body?.allow_downgrade === true,
    }, "upgrade"));

  app.post("/api/capabilities/:name/uninstall", (req, res) =>
    capabilityAction(req, res, {
      action: "uninstall",
      name: req.params.name,
      remove_knowledge: req.body?.remove_knowledge !== false,
    }, "uninstall"));

  app.get("/api/capabilities/:name/workflows", async (req, res) => {
    try {
      const result = await callDashboardTool("workflow", { action: "list", owner: req.params.name }, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
      return capabilityResult(res, result);
    } catch (error) {
      logError(req.originalUrl, 500, error, "capability", req.headers["user-agent"]);
      return res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerCapabilityRoutes };
