"use strict";

const CAPABILITY_MUTATIONS = new Set(["install", "configure", "enable", "disable", "upgrade", "uninstall"]);

function capabilityResult(res, result) {
  const text = result && result.content && result.content[0] ? result.content[0].text : "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { ok: !result?.isError, message: text };
  }
  if (result && result.isError) return res.status(400).json({ ok: false, ...payload });
  return res.json({ ok: true, ...payload });
}

function createCapabilityAction({ authenticatedUser, requireAttributedActor, auditLog, callDashboardTool, dashboardExecutionMetadata, logError }) {
  return async function capabilityAction(req, res, args, auditAction) {
    try {
      let actor = authenticatedUser(req);
      if (CAPABILITY_MUTATIONS.has(args.action)) {
        actor = requireAttributedActor(req, res, "Capability pack installation and lifecycle changes");
        if (!actor) return;
      }
      auditLog(req, `capability.${auditAction}`, { name: args.name || args.path || null });
      const result = await callDashboardTool("capability", args, dashboardExecutionMetadata(req, actor || "dashboard"));
      return capabilityResult(res, result);
    } catch (error) {
      logError(req.originalUrl, 500, error, "capability", req.headers["user-agent"]);
      return res.status(500).json({ ok: false, error: error.message });
    }
  };
}

module.exports = { CAPABILITY_MUTATIONS, capabilityResult, createCapabilityAction };
