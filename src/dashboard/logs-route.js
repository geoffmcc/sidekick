/** Register the dashboard activity/logs endpoint. */
function registerLogsRoute({ app, dbStore, normalizeLogEntry, buildActivitySessions, summarizeActivity, fallbackGapMs, errorResponse }) {
  app.get("/api/logs", (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      const needsPostFilter = !!(req.query.project || req.query.session || req.query.task ||
        req.query.execution || req.query.min_duration || req.query.errors_only === "true" || req.query.search);
      const dbFilters = {
        tool: req.query.tool || undefined,
        source: req.query.source || undefined,
        success: req.query.status === "success" ? true : req.query.status === "failure" ? false : undefined,
        limit: needsPostFilter ? Math.min(limit * 10, 5000) : limit,
      };
      let entries = dbStore.queryToolLogs(dbFilters).map(normalizeLogEntry);
      if (req.query.project) entries = entries.filter(entry => entry.project === req.query.project);
      if (req.query.session) entries = entries.filter(entry => entry.session_id === req.query.session || entry.task_id === req.query.session || entry.execution_id === req.query.session || String(entry.id).includes(req.query.session));
      if (req.query.task) entries = entries.filter(entry => entry.task_id === req.query.task);
      if (req.query.execution) entries = entries.filter(entry => entry.execution_id === req.query.execution);
      if (req.query.min_duration) {
        const minDuration = Number(req.query.min_duration);
        if (Number.isFinite(minDuration)) entries = entries.filter(entry => Number(entry.duration_ms || 0) >= minDuration);
      }
      if (req.query.errors_only === "true") entries = entries.filter(entry => !entry.ok || entry.error);
      if (req.query.search) {
        const needle = String(req.query.search).toLowerCase();
        entries = entries.filter(entry => [entry.tool, entry.args, entry.result, entry.error, entry.summary, entry.source, entry.project, entry.session_id, entry.task_id].join(" ").toLowerCase().includes(needle));
      }
      entries = entries.slice(0, limit);
      const sessions = buildActivitySessions(entries);
      return res.json({ entries, sessions, summary: summarizeActivity(sessions, entries), total: entries.length, fallback_grouping_ms: fallbackGapMs });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "logs" });
    }
  });
}

module.exports = { registerLogsRoute };
