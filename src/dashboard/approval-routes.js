/** Register dashboard approval inspection and resolution routes. */
function registerApprovalRoutes({ app, listApprovals, renderContinuationApprovalPreview, authenticatedUser, auditLog, logError, resolveApproval, requireIdentityPermission, errorResponse }) {
  app.get("/api/approvals", (req, res) => {
    if (req.authPrincipal && requireIdentityPermission && !requireIdentityPermission(req, res, "approvals.read")) return;
    if (!req.authPrincipal && authenticatedUser(req)) return res.status(403).json({ ok: false, error: "approval inspection requires an authenticated principal" });
    res.json({ ok: true, approvals: listApprovals({ status: req.query.status, limit: req.query.limit }) });
  });

  app.get("/api/approvals/:id/preview", (req, res) => {
    try {
      if (!authenticatedUser(req)) {
        return res.status(403).json({ ok: false, error: "Rendering approval arguments requires an authenticated principal; configure dashboard authentication" });
      }
      if (req.authPrincipal && requireIdentityPermission && !requireIdentityPermission(req, res, "approvals.read")) return;
      const preview = renderContinuationApprovalPreview(req.params.id);
      if (!preview.ok) return res.status(preview.code === "not_found" ? 404 : 409).json({ ok: false, error: preview.code });
      auditLog(req, "approval.preview", { id: req.params.id, viewer: authenticatedUser(req) });
      res.json({ ok: true, preview });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "approvals" });
    }
  });

  for (const [action, verb] of [["approve", "approve"], ["reject", "reject"]]) {
    app.post(`/api/approvals/:id/${action}`, async (req, res) => {
      try {
        const principalId = req.authPrincipal?.principal_id || null;
        if (!principalId) return res.status(401).json({ ok: false, error: "unauthenticated" });
        const permitted = requireIdentityPermission
          ? requireIdentityPermission(req, res, "approvals.grant")
          : true;
        if (!permitted) return;
        const reviewer = principalId;
        auditLog(req, `approval.${action}`, { id: req.params.id, reviewer_principal_id: principalId });
        const result = await resolveApproval(req.params.id, verb, reviewer, { reviewerPrincipalId: principalId });
        res.json({ ok: !result.isError, result: result.content?.[0]?.text || "" });
      } catch (error) {
        return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "approvals" });
      }
    });
  }
}

module.exports = { registerApprovalRoutes };
