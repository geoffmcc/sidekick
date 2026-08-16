/** Register dashboard approval inspection and resolution routes. */
function registerApprovalRoutes({ app, listApprovals, renderContinuationApprovalPreview, authenticatedUser, auditLog, logError, resolveApproval, requireIdentityPermission }) {
  app.get("/api/approvals", (req, res) => {
    res.json({ ok: true, approvals: listApprovals({ status: req.query.status, limit: req.query.limit }) });
  });

  app.get("/api/approvals/:id/preview", (req, res) => {
    try {
      if (!authenticatedUser(req)) {
        return res.status(403).json({ ok: false, error: "Rendering approval arguments requires an authenticated principal; configure dashboard authentication" });
      }
      const preview = renderContinuationApprovalPreview(req.params.id);
      if (!preview.ok) return res.status(preview.code === "not_found" ? 404 : 409).json({ ok: false, error: preview.code });
      auditLog(req, "approval.preview", { id: req.params.id, viewer: authenticatedUser(req) });
      res.json({ ok: true, preview });
    } catch (error) {
      logError(req.originalUrl, 500, error, "approvals", req.headers["user-agent"]);
      res.status(500).json({ ok: false, error: error.message });
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
        logError(req.originalUrl, 500, error, "approvals", req.headers["user-agent"]);
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  }
}

module.exports = { registerApprovalRoutes };
