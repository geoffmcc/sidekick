/** Register the dashboard summary endpoint around its injected assembler. */
function registerSummaryRoute({ app, handler }) {
  app.get("/api/dashboard-summary", handler);
}

module.exports = { registerSummaryRoute };
