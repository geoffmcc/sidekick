/** Register the dashboard summary endpoint around its injected assembler. */
function registerSummaryRoute({ app, handler, requireIdentityPermission }) {
  app.get("/api/dashboard-summary", (req, res, next) => {
    if (!requireIdentityPermission(req, res, "dashboard.operations.read")) return;
    return handler(req, res, next);
  });
}

module.exports = { registerSummaryRoute };
