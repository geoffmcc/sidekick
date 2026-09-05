"use strict";

const CAPABILITY_MUTATIONS = new Set(["install", "configure", "enable", "disable", "upgrade", "uninstall"]);

function capabilityResult(res, result, options = {}) {
  const text = result && result.content && result.content[0] ? result.content[0].text : "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { ok: !result?.isError, message: text };
  }
  if (result && result.isError) {
    if (options.errorResponse) {
      const code = result.approvalRequired ? "approval_required" : result.code === "policy_denied" ? "policy_denied" : "invalid_request";
      return options.errorResponse(options.req, res, null, { status: result.approvalRequired ? 202 : code === "policy_denied" ? 403 : 400, code, component: options.component || "dashboard_tool" });
    }
    return res.status(400).json({ ok: false, ...payload });
  }
  return res.json({ ok: true, ...payload });
}

function createCapabilityAction({ authenticatedUser, requireAttributedActor, auditLog, callDashboardTool, dashboardExecutionMetadata, logError, errorResponse }) {
  return async function capabilityAction(req, res, args, auditAction) {
    try {
      let actor = authenticatedUser(req);
      if (CAPABILITY_MUTATIONS.has(args.action)) {
        actor = requireAttributedActor(req, res, "Capability pack installation and lifecycle changes");
        if (!actor) return;
      }
      auditLog(req, `capability.${auditAction}`, { name: args.name || args.path || null });
      const result = await callDashboardTool("capability", args, dashboardExecutionMetadata(req, actor || "dashboard"));
      return capabilityResult(res, result, { req, errorResponse, component: "capability" });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "capability" });
    }
  };
}

module.exports = { CAPABILITY_MUTATIONS, capabilityResult, createCapabilityAction };
