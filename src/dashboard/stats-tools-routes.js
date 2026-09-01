/** Register dashboard statistics and tool-catalog routes. */
function registerStatsToolsRoutes({ app, dbStore, getToolDefsForSource }) {
  app.get("/api/stats", (req, res) => {
    const now = new Date();
    const since = req.query.since || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const until = req.query.until || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 5000) : 1000;
    const stats = {};
    for (const entry of dbStore.queryToolLogs({ since, until, limit })) {
      const name = entry.n;
      if (!stats[name]) stats[name] = { count: 0, ok: 0, fail: 0, totalMs: 0 };
      stats[name].count++;
      if (entry.ok) stats[name].ok++; else stats[name].fail++;
      stats[name].totalMs += entry.d || 0;
    }
    const result = Object.entries(stats).map(([name, stat]) => ({ name, count: stat.count, ok: stat.ok, fail: stat.fail, avgMs: Math.round(stat.totalMs / stat.count) })).sort((a, b) => b.count - a.count);
    res.json({ stats: result });
  });

  app.get("/api/tools", (req, res) => {
    const query = String(req.query.q || "").trim().toLowerCase().slice(0, 120);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 500;
    const tools = getToolDefsForSource("dashboard").filter(tool => !query || `${tool.name} ${tool.description || ""}`.toLowerCase().includes(query)).slice(0, limit);
    res.json({ tools, total: tools.length, limit, query: query || null });
  });
}

module.exports = { registerStatsToolsRoutes };
