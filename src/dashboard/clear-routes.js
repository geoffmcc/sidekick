"use strict";

function registerClearRoutes({ app, dbStore, clearConversationFiles, requireDashboardAdministrator, auditLog, errorResponse }) {
  function respondToClear(req, res, auditEvent, run) {
    try { auditLog(req, `${auditEvent}.requested`, {}); }
    catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: auditEvent }); }
    let detail;
    try { detail = run() || {}; }
    catch (error) {
      try { auditLog(req, `${auditEvent}.failed`, { error: "dashboard_action_failed" }); } catch {}
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: auditEvent });
    }
    let auditStatus = "complete";
    try { auditLog(req, auditEvent, detail); }
    catch { auditStatus = "degraded"; }
    return res.json({ ok: true, ...detail, audit_status: auditStatus });
  }

  app.delete("/api/logs", (req, res) => requireDashboardAdministrator(req, res)
    && respondToClear(req, res, "logs.clear", () => { dbStore.clearToolLogs(); return {}; }));

  app.delete("/api/kv", (req, res) => requireDashboardAdministrator(req, res)
    && respondToClear(req, res, "kv.clear", () => { dbStore.clearKV(); return {}; }));

  app.delete("/api/conversations", (req, res) => requireDashboardAdministrator(req, res)
    && respondToClear(req, res, "conversations.clear", () => ({ removed: clearConversationFiles() })));

  app.delete("/api/data", (req, res) => requireDashboardAdministrator(req, res)
    && respondToClear(req, res, "data.clear", () => {
      // Ordered so a failure reports which stage stopped the wipe rather than
      // claiming the whole clear succeeded.
      dbStore.clearToolLogs();
      dbStore.clearKV();
      return { removed: clearConversationFiles() };
    }));
}

module.exports = { registerClearRoutes };
