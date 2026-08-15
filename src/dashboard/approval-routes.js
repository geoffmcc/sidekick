/** Register dashboard approval inspection and resolution routes. */
function registerApprovalRoutes({ app, listApprovals, renderContinuationApprovalPreview, authenticatedUser, auditLog, logError, resolveApproval }) {
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
        const reviewer = authenticatedUser(req) || "unattributed:dashboard";
        auditLog(req, `approval.${action}`, { id: req.params.id, reviewer });
        const result = await resolveApproval(req.params.id, verb, reviewer);
        res.json({ ok: !result.isError, result: result.content?.[0]?.text || "" });
      } catch (error) {
        logError(req.originalUrl, 500, error, "approvals", req.headers["user-agent"]);
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  }
}

module.exports = { registerApprovalRoutes };
