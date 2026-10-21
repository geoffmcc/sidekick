/**
 * SQLite-backed key/value persistence.
 *
 * The database bootstrap supplies the connection and serialization helpers;
 * this module owns only the kv_store domain and keeps its public API stable.
 */
function createKvStore({ db, parseJson, nowIso }) {
  const MAX_KV_VALUE_BYTES = 2 * 1024 * 1024;
  function prefixUpperBound(prefix) {
    if (!prefix) return "\uFFFF";
    return `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
  }
  function loadKV(fallback = {}) {
    const rows = db.prepare("SELECT key, value_json FROM kv_store ORDER BY key").all();
    if (rows.length > 0) {
      const out = {};
      for (const row of rows) out[row.key] = parseJson(row.value_json, null);
      return out;
    }
    return fallback;
  }

  function clearKV() {
    db.prepare("DELETE FROM kv_store").run();
  }

  function getKV(key) {
    const row = db.prepare("SELECT CASE WHEN length(CAST(value_json AS BLOB)) <= ? THEN value_json ELSE NULL END AS value_json, length(CAST(value_json AS BLOB)) AS value_bytes FROM kv_store WHERE key = ?")
      .get(MAX_KV_VALUE_BYTES, key);
    if (row && row.value_bytes > MAX_KV_VALUE_BYTES) {
      const error = new Error("KV value exceeds the safe read limit");
      error.code = "KV_VALUE_TOO_LARGE";
      throw error;
    }
    return row ? parseJson(row.value_json, null) : null;
  }

  function hasKV(key) {
    return Boolean(db.prepare("SELECT 1 AS present FROM kv_store WHERE key = ?").get(key));
  }

  function setKV(key, value, project, source, category) {
    const ts = nowIso();
    const existing = getKV(key);
    const entry = {
      value,
      project: project || null,
      category: category || null,
      source: source || null,
      created: existing ? existing.created : ts,
      updated: ts,
    };
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, "utf8") > MAX_KV_VALUE_BYTES) {
      const error = new Error("KV value exceeds the 2 MiB storage limit");
      error.code = "KV_VALUE_TOO_LARGE";
      throw error;
    }
    db.prepare(`
      INSERT INTO kv_store (key, value_json, project, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        project = excluded.project,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(key, serialized, project, source, ts, ts);
  }

  function deleteKV(key) {
    db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  }

  function deleteKVByPrefix(prefix) {
    if (typeof prefix !== "string" || !prefix) throw new TypeError("A non-empty KV key prefix is required");
    const result = db.prepare("DELETE FROM kv_store WHERE key >= ? AND key < ?").run(prefix, prefixUpperBound(prefix));
    return result.changes;
  }

  function countKV() {
    return db.prepare("SELECT COUNT(*) AS count FROM kv_store").get().count;
  }

  function listKVProjects() {
    return db.prepare("SELECT DISTINCT project FROM kv_store WHERE project IS NOT NULL").all().map(row => row.project);
  }

  function listKVProjectPage(limit = 1000) {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 1000)));
    const rows = db.prepare("SELECT DISTINCT project FROM kv_store WHERE project IS NOT NULL ORDER BY project LIMIT ?").all(safeLimit + 1);
    return { projects: rows.slice(0, safeLimit).map(row => row.project), truncated: rows.length > safeLimit };
  }

  function listKVPage(limit = 1000) {
    return listScopedKV({ limit });
  }

  function getAllKV() {
    const out = {};
    for (const row of db.prepare("SELECT key, value_json FROM kv_store ORDER BY key").all()) {
      out[row.key] = parseJson(row.value_json, null);
    }
    return out;
  }

  function replaceKV(data) {
    const ts = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM kv_store").run();
      const insert = db.prepare(`
        INSERT INTO kv_store (key, value_json, project, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const [key, value] of Object.entries(data || {})) {
        const envelope = value && typeof value === "object" && !Array.isArray(value) ? value : null;
        insert.run(key, JSON.stringify(value), envelope?.project || null, envelope?.source || null, envelope?.created || ts, envelope?.updated || ts);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  // Scoped reads for user facing storage tools. Keep filtering and limits in
  // SQLite so a project request never materializes unrelated namespaces.
  function listScopedKV({ project, keyPrefix = "", limit = 1000 } = {}) {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 1000)));
    const upper = prefixUpperBound(keyPrefix);
    const scope = project !== undefined && project !== null
      ? { where: "project = ? AND key >= ? AND key < ?", values: [project, keyPrefix, upper] }
      : { where: "key >= ? AND key < ?", values: [keyPrefix, upper] };
    const oversized = db.prepare(`SELECT COUNT(*) AS count FROM kv_store WHERE ${scope.where} AND length(CAST(value_json AS BLOB)) > ?`)
      .get(...scope.values, MAX_KV_VALUE_BYTES).count;
    const rows = project !== undefined && project !== null
      ? db.prepare("SELECT key, value_json FROM kv_store WHERE project = ? AND key >= ? AND key < ? AND length(CAST(value_json AS BLOB)) <= ? ORDER BY key LIMIT ?")
        .all(project, keyPrefix, upper, MAX_KV_VALUE_BYTES, safeLimit + 1)
      : db.prepare("SELECT key, value_json FROM kv_store WHERE key >= ? AND key < ? AND length(CAST(value_json AS BLOB)) <= ? ORDER BY key LIMIT ?")
        .all(keyPrefix, upper, MAX_KV_VALUE_BYTES, safeLimit + 1);
    return {
      entries: rows.slice(0, safeLimit).map(row => [row.key, parseJson(row.value_json, null)]),
      truncated: rows.length > safeLimit,
      oversized,
    };
  }

  return { loadKV, clearKV, replaceKV, setKV, getKV, hasKV, deleteKV, deleteKVByPrefix, countKV, listKVProjects, listKVProjectPage, listKVPage, getAllKV, listScopedKV };
}

module.exports = { createKvStore };
