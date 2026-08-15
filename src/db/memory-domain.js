function createMemoryDomain({ db, hasMemoriesTable, normalizeMemoryRow, nowIso }) {
  function searchMemories({ query, project, type, limit = 10, includeDisabled = false } = {}) {
    if (!hasMemoriesTable()) return [];
    const clauses = [], params = [];
    if (!includeDisabled) clauses.push("enabled = 1");
    if (project) { clauses.push("(project = ? OR project IS NULL)"); params.push(project); }
    if (type && type !== "all") { clauses.push("type = ?"); params.push(type); }
    if (query) { clauses.push("(content LIKE ? OR summary LIKE ? OR tags LIKE ? OR source_tool LIKE ?)"); const like = `%${query}%`; params.push(like, like, like, like); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM memories ${where} ORDER BY confidence DESC, times_confirmed DESC, last_seen_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(Number(limit) || 10, 1000))).map(normalizeMemoryRow);
  }
  function listMemories(options = {}) { return searchMemories({ ...options, query: undefined }); }
  function getMemoryById(id, { includeDisabled = true } = {}) { if (!hasMemoriesTable() || !id) return null; return normalizeMemoryRow(db.prepare(`SELECT * FROM memories WHERE id = ? ${includeDisabled ? "" : "AND enabled = 1"}`).get(id)); }
  function disableMemory(id) { if (!hasMemoriesTable()) return false; return db.prepare("UPDATE memories SET enabled = 0, updated_at = ?, last_seen_at = ? WHERE id = ?").run(nowIso(), nowIso(), id).changes > 0; }
  function enableMemory(id) { if (!hasMemoriesTable()) return false; const ts = nowIso(); return db.prepare("UPDATE memories SET enabled = 1, updated_at = ?, last_seen_at = ? WHERE id = ? AND state NOT IN ('deleted', 'expired')").run(ts, ts, id).changes > 0; }
  function trimAutomaticMemories(max) { if (!hasMemoriesTable()) return 0; const limit = Math.max(1, Number(max) || 500), count = db.prepare("SELECT COUNT(*) AS count FROM memories WHERE automatic = 1 AND enabled = 1").get().count; if (count <= limit) return 0; return db.prepare("UPDATE memories SET enabled = 0, updated_at = ? WHERE id IN (SELECT id FROM memories WHERE automatic = 1 AND enabled = 1 ORDER BY last_seen_at ASC, updated_at ASC LIMIT ?)").run(nowIso(), count - limit).changes; }
  function expireStaleMemories(options = {}) { if (!hasMemoriesTable()) return { expired: 0 }; const cutoff = new Date(Date.now() - (options.staleDays || 90) * 86400000).toISOString(); const result = db.prepare("UPDATE memories SET enabled = 0, metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.expired_reason', 'stale'), updated_at = ? WHERE enabled = 1 AND (last_confirmed_at IS NULL OR last_confirmed_at < ?) AND (last_seen_at IS NULL OR last_seen_at < ?)").run(nowIso(), cutoff, cutoff); return { expired: result.changes, cutoff_date: cutoff }; }
  function calculateMemoryDecay(memory) { if (!memory) return 0; const now = Date.now(), confirmed = memory.last_confirmed_at ? new Date(memory.last_confirmed_at).getTime() : null, seen = memory.last_seen_at ? new Date(memory.last_seen_at).getTime() : null, created = memory.created_at ? new Date(memory.created_at).getTime() : now, daysConfirmed = confirmed ? (now - confirmed) / 86400000 : Infinity, daysSeen = seen ? (now - seen) / 86400000 : Infinity, age = (now - created) / 86400000, confirmationWeight = Math.log((memory.times_confirmed || 1) + 1) / Math.log(10), recency = Math.exp(-daysConfirmed / 180) * 0.6 + Math.exp(-daysSeen / 90) * 0.3 + Math.min(1, age / 30) * 0.1; return Math.max(0, Math.min(1, (memory.confidence || 0.5) * (0.3 + 0.7 * recency) * (0.5 + 0.5 * confirmationWeight))); }
  return { searchMemories, listMemories, getMemoryById, disableMemory, enableMemory, trimAutomaticMemories, expireStaleMemories, calculateMemoryDecay };
}
module.exports = { createMemoryDomain };
