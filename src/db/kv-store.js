/**
 * SQLite-backed key/value persistence.
 *
 * The database bootstrap supplies the connection and serialization helpers;
 * this module owns only the kv_store domain and keeps its public API stable.
 */
function createKvStore({ db, parseJson, nowIso }) {
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
    const row = db.prepare("SELECT value_json FROM kv_store WHERE key = ?").get(key);
    return row ? parseJson(row.value_json, null) : null;
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
    db.prepare(`
      INSERT INTO kv_store (key, value_json, project, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        project = excluded.project,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(entry), project, source, ts, ts);
  }

  function deleteKV(key) {
    db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  }

  function listKVProjects() {
    return db.prepare("SELECT DISTINCT project FROM kv_store WHERE project IS NOT NULL").all().map(row => row.project);
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

  return { loadKV, clearKV, replaceKV, setKV, getKV, deleteKV, listKVProjects, getAllKV };
}

module.exports = { createKvStore };
