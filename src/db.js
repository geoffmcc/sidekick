const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = process.env.SIDEKICK_DB_FILE || path.join(DATA_DIR, "sidekick.db");
const BACKUP_DIR = process.env.SIDEKICK_BACKUP_DIR || path.join(DATA_DIR, "backups");
const MIGRATIONS_DIR = process.env.SIDEKICK_MIGRATIONS_DIR || path.join(__dirname, "..", "migrations");
const MAX_LOG = Number(process.env.SIDEKICK_MAX_LOG || 1000);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o750 });

let Database;
try {
  Database = require("better-sqlite3");
} catch (error) {
  throw new Error(
    "Sidekick database mode requires the better-sqlite3 package. " +
    "Run `npm install` before starting Sidekick. Original error: " + error.message
  );
}

const db = new Database(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    project TEXT,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS json_documents (
    name TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tool_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args_summary TEXT,
    duration_ms INTEGER,
    success INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    source TEXT,
    entry_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tool_logs_timestamp ON tool_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_tool_logs_tool_name ON tool_logs(tool_name);
  CREATE INDEX IF NOT EXISTS idx_tool_logs_success ON tool_logs(success);
`);

db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "1");

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getDocument(name, fallback) {
  const row = db.prepare("SELECT data_json FROM json_documents WHERE name = ?").get(name);
  if (!row) return fallback;
  return parseJson(row.data_json, fallback);
}

function setDocument(name, data) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO json_documents (name, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(name, JSON.stringify(data, null, 2), ts, ts);
}

function loadDocument(name, fallback) {
  const existing = getDocument(name, undefined);
  return existing !== undefined ? existing : fallback;
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

function setKV(key, value, project, source, category) {
  const ts = nowIso();
  const existing = getKV(key);
  const created = existing ? existing.created : ts;
  const entry = {
    value: value,
    project: project || null,
    category: category || null,
    source: source || null,
    created: created,
    updated: ts
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

function getKV(key) {
  const row = db.prepare("SELECT value_json FROM kv_store WHERE key = ?").get(key);
  if (!row) return null;
  return parseJson(row.value_json, null);
}

function deleteKV(key) {
  db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
}

function listKVProjects() {
  const rows = db.prepare("SELECT DISTINCT project FROM kv_store WHERE project IS NOT NULL").all();
  return rows.map(r => r.project);
}

function getAllKV() {
  const rows = db.prepare("SELECT key, value_json FROM kv_store ORDER BY key").all();
  const out = {};
  for (const row of rows) {
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
      const project = value && typeof value === "object" && !Array.isArray(value) ? value.project || null : null;
      const source = value && typeof value === "object" && !Array.isArray(value) ? value.source || null : null;
      const created = value && typeof value === "object" && !Array.isArray(value) ? value.created || ts : ts;
      const updated = value && typeof value === "object" && !Array.isArray(value) ? value.updated || ts : ts;
      insert.run(key, JSON.stringify(value), project, source, created, updated);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function appendToolLog(entry) {
  db.prepare(`
    INSERT INTO tool_logs (timestamp, tool_name, args_summary, duration_ms, success, summary, source, entry_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.t || nowIso(),
    entry.n || "unknown",
    entry.a || "",
    Number.isFinite(entry.d) ? Math.round(entry.d) : null,
    entry.ok ? 1 : 0,
    entry.s || "",
    entry.src || "unknown",
    JSON.stringify(entry)
  );

  const countRow = db.prepare("SELECT COUNT(*) AS count FROM tool_logs").get();
  if (countRow.count > MAX_LOG) {
    db.prepare(`
      DELETE FROM tool_logs
      WHERE id IN (
        SELECT id FROM tool_logs
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
      )
    `).run(countRow.count - MAX_LOG);
  }
}

function readToolLogs(limit = MAX_LOG) {
  const rows = db.prepare("SELECT entry_json FROM tool_logs ORDER BY timestamp DESC, id DESC LIMIT ?").all(limit);
  return rows.map((row) => parseJson(row.entry_json, null)).filter(Boolean);
}

function clearToolLogs() {
  db.prepare("DELETE FROM tool_logs").run();
}

const MEMORY_CONFLICT_TYPES = new Set(["fact", "decision", "preference", "procedure", "open_thread", "observation"]);

const MEMORY_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "without", "into", "onto", "from",
  "to", "of", "in", "on", "at", "by", "it", "is", "are", "was", "were", "be", "been",
  "being", "this", "that", "these", "those", "i", "we", "you", "they", "he", "she",
  "prefer", "preferred", "prefers", "keep", "keeps", "kept", "choose", "chooses", "chosen",
  "use", "uses", "used", "avoid", "avoids", "avoided", "decide", "decides", "decided",
  "select", "selects", "selected", "choose", "choice", "decision", "follow", "followed",
  "followup", "follow", "needs", "need", "needed", "todo", "fix", "investigate", "pending",
  "blocked", "stable", "user", "project", "system", "fact", "preference", "open", "thread",
]);

function normalizeMemoryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    project: row.project,
    content: row.content,
    summary: row.summary,
    tags: parseJson(row.tags, []),
    confidence: row.confidence,
    source: row.source,
    source_tool: row.source_tool,
    source_task_id: row.source_task_id,
    source_ref: row.source_ref,
    metadata: parseJson(row.metadata_json, {}),
    enabled: !!row.enabled,
    automatic: !!row.automatic,
    times_confirmed: row.times_confirmed,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
    last_confirmed_at: row.last_confirmed_at,
    expires_at: row.expires_at,
    origin_machine_id: row.origin_machine_id,
    origin_user_id: row.origin_user_id,
    sync_version: row.sync_version,
    last_synced_at: row.last_synced_at
  };
}

function memoryTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean)
    .filter(w => !MEMORY_STOP_WORDS.has(w) && w.length > 1);
}

function memorySimilarity(textA, textB) {
  const a = new Set(memoryTokens(textA));
  const b = new Set(memoryTokens(textB));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / Math.max(a.size, b.size);
}

function readMemoryMetadata(row) {
  if (!row) return {};
  if (row.metadata_json !== undefined) {
    return parseJson(row.metadata_json, {});
  }
  return parseJson(row.metadata, {});
}

function supersedeMemoryRow(row, replacementId, reason, similarity, ts) {
  const metadata = readMemoryMetadata(row);
  metadata.state = "superseded";
  metadata.superseded_by = replacementId;
  metadata.superseded_at = ts;
  metadata.supersession_reason = reason;
  metadata.supersession_similarity = similarity;

  db.prepare(`
    UPDATE memories
    SET enabled = 0,
        metadata_json = ?,
        updated_at = ?,
        last_seen_at = ?
    WHERE id = ?
  `).run(JSON.stringify(metadata), ts, ts, row.id);

  return normalizeMemoryRow(db.prepare("SELECT * FROM memories WHERE id = ?").get(row.id));
}

function hasMemoriesTable() {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get();
  return !!row;
}

function makeMemoryDedupKey(memory) {
  return [
    memory.type || "",
    memory.project || "",
    memory.source_tool || "",
    String(memory.content || "").trim().toLowerCase().slice(0, 500)
  ].join("\u001f");
}

function upsertMemory(memory) {
  if (!hasMemoriesTable()) return null;

  const ts = nowIso();
  const type = memory.type || "observation";
  const content = String(memory.content || memory.summary || "").trim();
  if (!content) return null;

  const project = memory.project || null;
  const sourceTool = memory.source_tool || memory.tool || null;
  const metadata = { ...(memory.metadata || {}) };
  const dedupKey = makeMemoryDedupKey({ ...memory, type, project, source_tool: sourceTool, content });
  const existingRows = db.prepare(`
    SELECT * FROM memories
    WHERE enabled = 1
      AND type = ?
      AND COALESCE(project, '') = COALESCE(?, '')
      AND COALESCE(source_tool, '') = COALESCE(?, '')
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(type, project, sourceTool);

  for (const row of existingRows) {
    const rowKey = makeMemoryDedupKey({
      type: row.type,
      project: row.project,
      source_tool: row.source_tool,
      content: row.content
    });
    if (rowKey === dedupKey) {
      const rowMetadata = readMemoryMetadata(row);
      const mergedMetadata = { ...rowMetadata, ...metadata };
      mergedMetadata.state = rowMetadata.state || "active";
      db.prepare(`
        UPDATE memories
        SET summary = ?,
            tags = ?,
            confidence = MAX(confidence, ?),
            source = ?,
            source_task_id = COALESCE(?, source_task_id),
            source_ref = COALESCE(?, source_ref),
            metadata_json = ?,
            times_confirmed = times_confirmed + 1,
            updated_at = ?,
            last_seen_at = ?,
            last_confirmed_at = ?
        WHERE id = ?
      `).run(
        memory.summary || row.summary,
        JSON.stringify(memory.tags || parseJson(row.tags, [])),
        Number.isFinite(memory.confidence) ? memory.confidence : row.confidence,
        memory.source || row.source,
        memory.source_task_id || null,
        memory.source_ref || null,
        JSON.stringify(mergedMetadata),
        ts,
        ts,
        ts,
        row.id
      );
      return normalizeMemoryRow(db.prepare("SELECT * FROM memories WHERE id = ?").get(row.id));
    }
  }

  const newConfidence = Number.isFinite(memory.confidence) ? memory.confidence : 0.5;

  const conflictCandidates = existingRows.filter((row) => {
    if (!MEMORY_CONFLICT_TYPES.has(type)) return false;
    const rowMetadata = readMemoryMetadata(row);
    if (rowMetadata.state === "superseded") return false;
    if (String(row.content || "").trim().toLowerCase() === content.toLowerCase()) return false;
    if (row.confidence > newConfidence) return false;
    return memorySimilarity(content, row.content) >= 0.6;
  });

  const id = memory.id || `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (conflictCandidates.length > 0) {
    metadata.state = "active";
    metadata.conflicts_with = conflictCandidates.map(row => row.id);
    metadata.conflict_reason = "similar_content";
  }
  
  const machineId = getMachineId();
  const userId = getUserId();
  
  db.prepare(`
    INSERT INTO memories (
      id, type, project, content, summary, tags, confidence, source, source_tool,
      source_task_id, source_ref, metadata_json, enabled, automatic,
      times_confirmed, created_at, updated_at, last_seen_at, last_confirmed_at, expires_at,
      origin_machine_id, origin_user_id, sync_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    type,
    project,
    content,
    memory.summary || content,
    JSON.stringify(memory.tags || []),
    Number.isFinite(memory.confidence) ? memory.confidence : 0.5,
    memory.source || null,
    sourceTool,
    memory.source_task_id || null,
    memory.source_ref || null,
    JSON.stringify(metadata),
    memory.enabled === false ? 0 : 1,
    memory.automatic === false ? 0 : 1,
    Number.isFinite(memory.times_confirmed) ? memory.times_confirmed : 1,
    memory.created_at || ts,
    ts,
    memory.last_seen_at || ts,
    ts,
    memory.expires_at || null,
    memory.origin_machine_id || machineId,
    memory.origin_user_id || userId,
    memory.sync_version || 1
  );

  if (conflictCandidates.length > 0) {
    for (const row of conflictCandidates) {
      supersedeMemoryRow(row, id, "similar_content", memorySimilarity(content, row.content), ts);
    }
  }

  return normalizeMemoryRow(db.prepare("SELECT * FROM memories WHERE id = ?").get(id));
}

function searchMemories({ query, project, type, limit = 10, includeDisabled = false } = {}) {
  if (!hasMemoriesTable()) return [];

  const clauses = [];
  const params = [];
  if (!includeDisabled) clauses.push("enabled = 1");
  if (project) {
    clauses.push("(project = ? OR project IS NULL)");
    params.push(project);
  }
  if (type && type !== "all") {
    clauses.push("type = ?");
    params.push(type);
  }
  if (query) {
    clauses.push("(content LIKE ? OR summary LIKE ? OR tags LIKE ? OR source_tool LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT * FROM memories
    ${where}
    ORDER BY confidence DESC, times_confirmed DESC, last_seen_at DESC
    LIMIT ?
  `).all(...params, Math.max(1, Math.min(Number(limit) || 10, 100)));

  return rows.map(normalizeMemoryRow);
}

function listMemories(options = {}) {
  return searchMemories({ ...options, query: undefined });
}

function disableMemory(id) {
  if (!hasMemoriesTable()) return false;
  const result = db.prepare("UPDATE memories SET enabled = 0, updated_at = ?, last_seen_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
  return result.changes > 0;
}

function trimAutomaticMemories(max) {
  if (!hasMemoriesTable()) return 0;
  const limit = Math.max(1, Number(max) || 500);
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM memories WHERE automatic = 1 AND enabled = 1").get();
  if (countRow.count <= limit) return 0;
  const result = db.prepare(`
    UPDATE memories
    SET enabled = 0, updated_at = ?
    WHERE id IN (
      SELECT id FROM memories
      WHERE automatic = 1 AND enabled = 1
      ORDER BY last_seen_at ASC, updated_at ASC
      LIMIT ?
    )
  `).run(nowIso(), countRow.count - limit);
  return result.changes;
}

// === Memory Lifecycle ===

function expireStaleMemories(options = {}) {
  if (!hasMemoriesTable()) return { expired: 0 };

  const staleDays = options.staleDays || 90;
  const ts = nowIso();
  const cutoffDate = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    UPDATE memories
    SET enabled = 0,
        metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.expired_reason', 'stale'),
        updated_at = ?
    WHERE enabled = 1
      AND (last_confirmed_at IS NULL OR last_confirmed_at < ?)
      AND (last_seen_at IS NULL OR last_seen_at < ?)
  `).run(ts, cutoffDate, cutoffDate);

  return { expired: result.changes, cutoff_date: cutoffDate };
}

function calculateMemoryDecay(memory) {
  if (!memory) return 0;

  const now = Date.now();
  const lastConfirmed = memory.last_confirmed_at ? new Date(memory.last_confirmed_at).getTime() : null;
  const lastSeen = memory.last_seen_at ? new Date(memory.last_seen_at).getTime() : null;
  const created = memory.created_at ? new Date(memory.created_at).getTime() : now;

  const daysSinceConfirm = lastConfirmed ? (now - lastConfirmed) / (24 * 60 * 60 * 1000) : Infinity;
  const daysSinceSeen = lastSeen ? (now - lastSeen) / (24 * 60 * 60 * 1000) : Infinity;
  const ageDays = (now - created) / (24 * 60 * 60 * 1000);

  const baseConfidence = memory.confidence || 0.5;
  const confirmations = memory.times_confirmed || 1;

  const confirmDecay = Math.exp(-daysSinceConfirm / 180);
  const seenDecay = Math.exp(-daysSinceSeen / 90);
  const ageBoost = Math.min(1, ageDays / 30);

  const confirmationWeight = Math.log(confirmations + 1) / Math.log(10);
  const recencyScore = (confirmDecay * 0.6) + (seenDecay * 0.3) + (ageBoost * 0.1);

  const decayedConfidence = baseConfidence * (0.3 + 0.7 * recencyScore) * (0.5 + 0.5 * confirmationWeight);

  return Math.max(0, Math.min(1, decayedConfidence));
}

function getMemoryStats() {
  if (!hasMemoriesTable()) {
    return {
      total: 0,
      active: 0,
      disabled: 0,
      superseded: 0,
      by_type: {},
      by_project: {},
      avg_confidence: 0,
      oldest_unconfirmed: null,
      stale_count: 0
    };
  }

  const total = db.prepare("SELECT COUNT(*) as count FROM memories").get().count;
  const active = db.prepare("SELECT COUNT(*) as count FROM memories WHERE enabled = 1").get().count;
  const disabled = total - active;

  const supersededResult = db.prepare(`
    SELECT COUNT(*) as count FROM memories
    WHERE metadata_json LIKE '%"state":"superseded"%'
  `).get();
  const superseded = supersededResult.count;

  const byTypeRows = db.prepare(`
    SELECT type, COUNT(*) as count FROM memories
    WHERE enabled = 1
    GROUP BY type
    ORDER BY count DESC
  `).all();
  const by_type = {};
  for (const row of byTypeRows) {
    by_type[row.type] = row.count;
  }

  const byProjectRows = db.prepare(`
    SELECT COALESCE(project, 'global') as project, COUNT(*) as count FROM memories
    WHERE enabled = 1
    GROUP BY project
    ORDER BY count DESC
  `).all();
  const by_project = {};
  for (const row of byProjectRows) {
    by_project[row.project] = row.count;
  }

  const avgConfRow = db.prepare(`
    SELECT AVG(confidence) as avg_conf FROM memories
    WHERE enabled = 1
  `).get();
  const avg_confidence = avgConfRow.avg_conf || 0;

  const oldestUnconfRow = db.prepare(`
    SELECT id, last_confirmed_at, created_at FROM memories
    WHERE enabled = 1 AND times_confirmed = 1
    ORDER BY created_at ASC
    LIMIT 1
  `).get();
  const oldest_unconfirmed = oldestUnconfRow ? {
    id: oldestUnconfRow.id,
    created_at: oldestUnconfRow.created_at,
    days_old: Math.floor((Date.now() - new Date(oldestUnconfRow.created_at).getTime()) / (24 * 60 * 60 * 1000))
  } : null;

  const staleCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const staleCount = db.prepare(`
    SELECT COUNT(*) as count FROM memories
    WHERE enabled = 1
      AND (last_confirmed_at IS NULL OR last_confirmed_at < ?)
  `).get(staleCutoff).count;

  return {
    total,
    active,
    disabled,
    superseded,
    by_type,
    by_project,
    avg_confidence: Math.round(avg_confidence * 100) / 100,
    oldest_unconfirmed,
    stale_count: staleCount
  };
}

// === Memory Import/Export ===

function exportMemories(options = {}) {
  if (!hasMemoriesTable()) return { memories: [], exported_at: nowIso() };

  const clauses = [];
  const params = [];

  if (options.project) {
    clauses.push("project = ?");
    params.push(options.project);
  }
  if (options.type) {
    clauses.push("type = ?");
    params.push(options.type);
  }
  if (options.includeDisabled === false) {
    clauses.push("enabled = 1");
  }
  if (options.automatic !== undefined) {
    clauses.push("automatic = ?");
    params.push(options.automatic ? 1 : 0);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT * FROM memories ${where}
    ORDER BY updated_at DESC
  `).all(...params);

  const memories = rows.map(row => ({
    id: row.id,
    type: row.type,
    project: row.project,
    content: row.content,
    summary: row.summary,
    tags: parseJson(row.tags, []),
    confidence: row.confidence,
    source: row.source,
    source_tool: row.source_tool,
    source_task_id: row.source_task_id,
    source_ref: row.source_ref,
    metadata: parseJson(row.metadata_json, {}),
    enabled: !!row.enabled,
    automatic: !!row.automatic,
    times_confirmed: row.times_confirmed,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
    last_confirmed_at: row.last_confirmed_at,
    expires_at: row.expires_at,
    origin_machine_id: row.origin_machine_id,
    origin_user_id: row.origin_user_id,
    sync_version: row.sync_version || 1
  }));

  return {
    version: 2,
    machine_id: getMachineId(),
    user_id: getUserId(),
    exported_at: nowIso(),
    count: memories.length,
    filter: {
      project: options.project || null,
      type: options.type || null,
      includeDisabled: options.includeDisabled !== false,
      automatic: options.automatic
    },
    memories
  };
}

function importMemories(data, options = {}) {
  if (!hasMemoriesTable()) return { imported: 0, skipped: 0, errors: ["memories table not found"] };
  if (!data || !Array.isArray(data.memories)) {
    return { imported: 0, skipped: 0, errors: ["invalid import data: missing memories array"] };
  }

  const ts = nowIso();
  let imported = 0;
  let skipped = 0;
  let updated = 0;
  const errors = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const mem of data.memories) {
      if (!mem.type || !mem.content) {
        errors.push(`skipped: missing type or content for memory`);
        skipped++;
        continue;
      }

      const existing = db.prepare(`
        SELECT id, metadata_json, times_confirmed FROM memories
        WHERE type = ? AND COALESCE(project, '') = COALESCE(?, '') AND content = ?
        LIMIT 1
      `).get(mem.type, mem.project || null, mem.content);

      if (existing) {
        if (options.onConflict === "skip") {
          skipped++;
          continue;
        }

        const existingMeta = parseJson(existing.metadata_json, {});
        const newMeta = { ...existingMeta, ...(mem.metadata || {}), imported_at: ts, import_source: "import" };

        db.prepare(`
          UPDATE memories
          SET summary = ?,
              tags = ?,
              confidence = MAX(confidence, ?),
              metadata_json = ?,
              times_confirmed = times_confirmed + 1,
              updated_at = ?,
              last_seen_at = ?
          WHERE id = ?
        `).run(
          mem.summary || mem.content,
          JSON.stringify(mem.tags || []),
          Number.isFinite(mem.confidence) ? mem.confidence : 0.5,
          JSON.stringify(newMeta),
          ts,
          ts,
          existing.id
        );
        updated++;
        continue;
      }

      const id = options.preserveIds && mem.id ? mem.id : `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const metadata = { ...(mem.metadata || {}), imported_at: ts, import_source: "import" };

      db.prepare(`
        INSERT INTO memories (
          id, type, project, content, summary, tags, confidence, source, source_tool,
          source_task_id, source_ref, metadata_json, enabled, automatic,
          times_confirmed, created_at, updated_at, last_seen_at, last_confirmed_at,
          expires_at, origin_machine_id, origin_user_id, sync_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        mem.type,
        mem.project || null,
        mem.content,
        mem.summary || mem.content,
        JSON.stringify(mem.tags || []),
        Number.isFinite(mem.confidence) ? mem.confidence : 0.5,
        mem.source || "import",
        mem.source_tool || null,
        mem.source_task_id || null,
        mem.source_ref || null,
        JSON.stringify(metadata),
        mem.enabled === false ? 0 : 1,
        mem.automatic === false ? 0 : 1,
        Number.isFinite(mem.times_confirmed) ? mem.times_confirmed : 1,
        mem.created_at || ts,
        ts,
        mem.last_seen_at || ts,
        ts,
        mem.expires_at || null,
        mem.origin_machine_id || null,
        mem.origin_user_id || null,
        mem.sync_version || 1
      );
      imported++;
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { imported, skipped, updated, errors: [...errors, e.message] };
  }

  return { imported, skipped, updated, errors };
}

// === Database Tool Helpers ===

function clampLimit(limit) {
  const parsed = parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1000;
  return Math.min(parsed, 5000);
}

function isReadonlySql(sql) {
  const trimmed = String(sql || "").trim();
  if (!trimmed) return false;
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) return false;

  const upper = withoutTrailingSemicolon.toUpperCase();
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|ATTACH|DETACH|REINDEX)\b/.test(upper)) {
    return false;
  }
  if (upper.startsWith("PRAGMA")) {
    return /^PRAGMA\s+(TABLE_INFO|INDEX_LIST|INDEX_INFO|FOREIGN_KEY_LIST|JOURNAL_MODE|PAGE_COUNT|PAGE_SIZE|DATABASE_LIST|INTEGRITY_CHECK|QUICK_CHECK)\b/.test(upper);
  }
  return /^(SELECT|WITH|EXPLAIN)\b/.test(upper);
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function executeQuery(sql, params = [], options = {}) {
  const { readonly = true, limit = 1000, timeout = 5000 } = options;
  const maxRows = clampLimit(limit);
  
  if (readonly && !isReadonlySql(sql)) {
    throw new Error("Write operations and multi-statement SQL are not allowed in readonly mode. Set readonly=false to allow.");
  }
  
  let limitedSql = sql;
  if (readonly && !/^\s*PRAGMA\b/i.test(sql) && !/\bLIMIT\b/i.test(sql)) {
    limitedSql = sql.replace(/;?\s*$/, "") + ` LIMIT ${maxRows}`;
  }
  
  const stmt = db.prepare(limitedSql);
  if (readonly && !stmt.reader) {
    throw new Error("Readonly mode only allows statements that return rows.");
  }
  const results = stmt.all(...params);
  return results.slice(0, maxRows);
}

function getTableList() {
  return db.prepare(`
    SELECT name, type, sql 
    FROM sqlite_master 
    WHERE type IN ('table', 'view') 
    AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
}

function getTableInfo(tableName) {
  const table = quoteIdentifier(tableName);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  
  const indexDetails = indexes.map(idx => ({
    ...idx,
    columns: db.prepare(`PRAGMA index_info(${quoteIdentifier(idx.name)})`).all()
  }));
  
  let rowCount = 0;
  try {
    rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
  } catch (e) {}
  
  return { columns, indexes: indexDetails, foreignKeys, rowCount };
}

function getDatabaseStats() {
  const dbSize = fs.statSync(DB_FILE).size;
  
  const pageCount = db.prepare("PRAGMA page_count").get().page_count;
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  const freelistCount = db.prepare("PRAGMA freelist_count").get().freelist_count;
  
  const journalMode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  const walCheckpoint = db.prepare("PRAGMA wal_checkpoint").get();
  
  const cacheSize = db.prepare("PRAGMA cache_size").get().cache_size;
  
  let cacheHitRatio = null;
  try {
    const stats = db.prepare(`
      SELECT 
        SUM(CASE WHEN name LIKE 'sqlite_stat%' THEN 0 ELSE 1 END) as user_tables
      FROM sqlite_master 
      WHERE type = 'table'
    `).get();
  } catch (e) {}
  
  const tables = getTableList();
  const tableStats = tables.map(t => {
    let size = 0;
    let rowCount = 0;
    try {
      rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${t.name}`).get().count;
      size = db.prepare(`SELECT page_count * ${pageSize} as size FROM pragma_page_count('${t.name}')`).get().size || 0;
    } catch (e) {}
    return { name: t.name, rowCount, size };
  });
  
  return {
    dbSize,
    dbSizeHuman: formatBytes(dbSize),
    pageCount,
    pageSize,
    freelistCount,
    journalMode,
    walCheckpoint,
    cacheSize,
    tables: tableStats,
    totalTables: tables.length
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

function createBackup(destPath = null, compress = true) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `sidekick-backup-${timestamp}.db`;
  const backupPath = destPath || path.join(BACKUP_DIR, backupName);
  
  // Close main db to ensure clean state, then copy
  const backupDb = new Database(backupPath);
  try {
    // Use synchronous backup via file copy
    // First checkpoint WAL to main db file
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
    // Copy the database file
    fs.copyFileSync(DB_FILE, backupPath);
    backupDb.close();
    
    if (compress) {
      const input = fs.readFileSync(backupPath);
      const compressed = zlib.gzipSync(input);
      fs.writeFileSync(backupPath + ".gz", compressed);
      fs.unlinkSync(backupPath);
      return { path: backupPath + ".gz", size: compressed.length, compressed: true };
    }
    
    return { path: backupPath, size: fs.statSync(backupPath).size, compressed: false };
  } catch (err) {
    try { backupDb.close(); } catch (e) {}
    throw err;
  }
}

function restoreBackup(backupPath, verify = true) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }
  
  let tempPath = backupPath;
  if (backupPath.endsWith(".gz")) {
    tempPath = backupPath.replace(".gz", ".tmp");
    const compressed = fs.readFileSync(backupPath);
    const decompressed = zlib.gunzipSync(compressed);
    fs.writeFileSync(tempPath, decompressed);
  }
  
  if (verify) {
    const testDb = new Database(tempPath);
    try {
      testDb.prepare("PRAGMA integrity_check").get();
    } catch (e) {
      testDb.close();
      if (tempPath !== backupPath) fs.unlinkSync(tempPath);
      throw new Error("Backup integrity check failed: " + e.message);
    }
    testDb.close();
  }
  
  // Create pre-restore backup using synchronous file copy
  const preBackupPath = path.join(BACKUP_DIR, `pre-restore-${Date.now()}.db`);
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
    fs.copyFileSync(DB_FILE, preBackupPath);
  } catch (err) {
    if (tempPath !== backupPath) fs.unlinkSync(tempPath);
    throw err;
  }
  
  // Restore by copying backup file over main db
  try {
    fs.copyFileSync(tempPath, DB_FILE);
    if (tempPath !== backupPath) fs.unlinkSync(tempPath);
    return { success: true, preBackupPath };
  } catch (err) {
    if (tempPath !== backupPath) fs.unlinkSync(tempPath);
    throw err;
  }
}

function queryToolLogs(filters = {}) {
  const { tool, source, success, since, until, limit = 100 } = filters;
  
  let where = [];
  let params = [];
  
  if (tool) {
    where.push("tool_name = ?");
    params.push(tool);
  }
  if (source) {
    where.push("source = ?");
    params.push(source);
  }
  if (success !== undefined && success !== null) {
    where.push("success = ?");
    params.push(success ? 1 : 0);
  }
  if (since) {
    where.push("timestamp >= ?");
    params.push(since);
  }
  if (until) {
    where.push("timestamp <= ?");
    params.push(until);
  }
  
  const whereClause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
  const sql = `SELECT entry_json FROM tool_logs ${whereClause} ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);
  
  const rows = db.prepare(sql).all(...params);
  return rows.map(row => parseJson(row.entry_json, null)).filter(Boolean);
}

function exportTable(tableName, format = "json") {
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
  
  if (format === "json") {
    return JSON.stringify(rows, null, 2);
  }
  
  if (format === "csv") {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const csvRows = [headers.join(",")];
    for (const row of rows) {
      const values = headers.map(h => {
        const val = row[h];
        if (val === null) return "";
        if (typeof val === "string" && (val.includes(",") || val.includes('"') || val.includes("\n"))) {
          return '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      });
      csvRows.push(values.join(","));
    }
    return csvRows.join("\n");
  }
  
  if (format === "sql") {
    const lines = [];
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map(c => {
        const val = row[c];
        if (val === null) return "NULL";
        if (typeof val === "number") return val;
        return "'" + String(val).replace(/'/g, "''") + "'";
      });
      lines.push(`INSERT INTO ${tableName} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
    }
    return lines.join("\n");
  }
  
  throw new Error(`Unsupported export format: ${format}`);
}

function setupFTS5() {
  const tables = getTableList().filter(t => t.type === "table");
  
  for (const table of tables) {
    const ftsTableName = `${table.name}_fts`;
    
    try {
      db.prepare(`DROP TABLE IF EXISTS ${ftsTableName}`).run();
    } catch (e) {}
    
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
    const textColumns = columns.filter(c => 
      c.type.toUpperCase().includes("TEXT") || 
      c.type.toUpperCase().includes("CHAR") ||
      c.type.toUpperCase().includes("CLOB")
    );
    
    if (textColumns.length === 0) continue;
    
    const columnNames = textColumns.map(c => c.name).join(", ");
    
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTableName} USING fts5(
          rowid UNINDEXED,
          ${textColumns.map(c => c.name).join(", ")}
        );
        
        INSERT INTO ${ftsTableName} (rowid, ${columnNames})
        SELECT rowid, ${columnNames} FROM ${table.name};
      `);
    } catch (e) {
      console.error(`FTS5 setup failed for ${table.name}:`, e.message);
    }
  }
  
  return { success: true };
}

function searchAllTables(query, options = {}) {
  const { tables = null, limit = 50 } = options;
  
  const results = [];
  const ftsTables = getTableList().filter(t => t.name.endsWith("_fts"));
  
  for (const ftsTable of ftsTables) {
    const baseTableName = ftsTable.name.replace("_fts", "");
    
    if (tables && !tables.includes(baseTableName)) continue;
    
    try {
      const rows = db.prepare(`
        SELECT rowid, * FROM ${ftsTable.name} 
        WHERE ${ftsTable.name} MATCH ? 
        LIMIT ?
      `).all(query, limit);
      
      for (const row of rows) {
        results.push({
          table: baseTableName,
          rowid: row.rowid,
          snippet: Object.values(row).filter(v => typeof v === "string").join(" ").substring(0, 200)
        });
      }
    } catch (e) {}
  }
  
  if (results.length === 0) {
    const searchTables = tables 
      ? getTableList().filter(t => tables.includes(t.name) && t.type === "table")
      : getTableList().filter(t => t.type === "table");
    
    for (const table of searchTables) {
      const columns = db.prepare(`PRAGMA table_info(${table.name})`).all();
      const textColumns = columns.filter(c => 
        c.type.toUpperCase().includes("TEXT") || 
        c.type.toUpperCase().includes("CHAR")
      );
      
      for (const col of textColumns) {
        try {
          const rows = db.prepare(`
            SELECT rowid, ${col.name} FROM ${table.name}
            WHERE ${col.name} LIKE ?
            LIMIT ?
          `).all(`%${query}%`, Math.min(limit, 10));
          
          for (const row of rows) {
            results.push({
              table: table.name,
              rowid: row.rowid,
              column: col.name,
              snippet: String(row[col.name]).substring(0, 200)
            });
          }
        } catch (e) {}
      }
      
      if (results.length >= limit) break;
    }
  }
  
  return results.slice(0, limit);
}

function getMigrationVersion() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? parseInt(row.value, 10) : 0;
}

function runMigration(name, upSql, downSql) {
  const currentVersion = getMigrationVersion();
  
  const migrationMatch = name.match(/^(\d+)_/);
  if (!migrationMatch) {
    throw new Error("Migration name must start with version number: NNN_name.sql");
  }
  const targetVersion = parseInt(migrationMatch[1], 10);
  
  if (targetVersion <= currentVersion) {
    return { skipped: true, reason: "Migration already applied" };
  }
  
  db.exec(upSql);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(targetVersion));
  
  return { success: true, version: targetVersion };
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();
  
  const currentVersion = getMigrationVersion();
  
  return files.map(f => {
    const match = f.match(/^(\d+)_/);
    const version = match ? parseInt(match[1], 10) : 0;
    return {
      file: f,
      version,
      applied: version <= currentVersion
    };
  });
}

function runPendingMigrations() {
  const migrations = listMigrations();
  const pending = migrations.filter(m => !m.applied);
  
  if (pending.length === 0) {
    return { applied: 0, migrations: [] };
  }
  
  const applied = [];
  for (const migration of pending) {
    const migrationPath = path.join(MIGRATIONS_DIR, migration.file);
    const sql = fs.readFileSync(migrationPath, "utf-8");
    
    try {
      db.exec(sql);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(migration.version));
      applied.push({ file: migration.file, version: migration.version });
    } catch (error) {
      console.error(`[Migration] Failed to apply ${migration.file}:`, error.message);
      throw error;
    }
  }
  
  return { applied: applied.length, migrations: applied };
}

function createSnapshot() {
  const tables = getTableList().filter(t => t.type === "table");
  const snapshot = {};
  
  for (const table of tables) {
    snapshot[table.name] = db.prepare(`SELECT * FROM ${table.name}`).all();
  }
  
  return {
    timestamp: nowIso(),
    tables: snapshot
  };
}

function compareSnapshots(snapshotA, snapshotB) {
  const diff = {};
  
  const allTables = new Set([
    ...Object.keys(snapshotA.tables || {}),
    ...Object.keys(snapshotB.tables || {})
  ]);
  
  for (const tableName of allTables) {
    const rowsA = snapshotA.tables[tableName] || [];
    const rowsB = snapshotB.tables[tableName] || [];
    
    const mapA = new Map(rowsA.map(r => [JSON.stringify(r), r]));
    const mapB = new Map(rowsB.map(r => [JSON.stringify(r), r]));
    
    const added = rowsB.filter(r => !mapA.has(JSON.stringify(r)));
    const removed = rowsA.filter(r => !mapB.has(JSON.stringify(r)));
    
    if (added.length > 0 || removed.length > 0) {
      diff[tableName] = { added, removed };
    }
  }
  
  return diff;
}

// === Cross-Machine Sync ===

function getMachineId() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'machine_id'").get();
  if (row) return row.value;
  
  const crypto = require("crypto");
  const machineId = crypto.randomUUID();
  db.prepare("INSERT INTO meta (key, value) VALUES ('machine_id', ?)").run(machineId);
  return machineId;
}

function getUserId() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'user_id'").get();
  return row ? row.value : null;
}

function setUserId(userId) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(userId);
  return userId;
}

function exportForSync(options = {}) {
  if (!hasMemoriesTable()) return { memories: [], exported_at: nowIso() };
  
  const machineId = getMachineId();
  const userId = getUserId();
  
  const clauses = [];
  const params = [];
  
  if (options.project) {
    clauses.push("project = ?");
    params.push(options.project);
  }
  if (options.since) {
    clauses.push("updated_at > ?");
    params.push(options.since);
  }
  if (options.includeDisabled === false) {
    clauses.push("enabled = 1");
  }
  
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT * FROM memories ${where}
    ORDER BY updated_at DESC
  `).all(...params);
  
  const memories = rows.map(row => ({
    id: row.id,
    type: row.type,
    project: row.project,
    content: row.content,
    summary: row.summary,
    tags: parseJson(row.tags, []),
    confidence: row.confidence,
    source: row.source,
    source_tool: row.source_tool,
    source_task_id: row.source_task_id,
    source_ref: row.source_ref,
    metadata: parseJson(row.metadata_json, {}),
    enabled: !!row.enabled,
    automatic: !!row.automatic,
    times_confirmed: row.times_confirmed,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen_at: row.last_seen_at,
    last_confirmed_at: row.last_confirmed_at,
    expires_at: row.expires_at,
    origin_machine_id: row.origin_machine_id,
    origin_user_id: row.origin_user_id,
    sync_version: row.sync_version || 1
  }));
  
  return {
    version: 2,
    machine_id: machineId,
    user_id: userId,
    exported_at: nowIso(),
    count: memories.length,
    memories
  };
}

function resolveConflict(local, remote, strategy = "newest") {
  switch (strategy) {
    case "newest":
      return new Date(remote.updated_at) > new Date(local.updated_at) ? "remote" : "local";
    
    case "highest_confidence":
      if (remote.confidence > local.confidence) return "remote";
      if (local.confidence > remote.confidence) return "local";
      return new Date(remote.updated_at) > new Date(local.updated_at) ? "remote" : "local";
    
    case "most_confirmed":
      if (remote.times_confirmed > local.times_confirmed) return "remote";
      if (local.times_confirmed > remote.times_confirmed) return "local";
      return new Date(remote.updated_at) > new Date(local.updated_at) ? "remote" : "local";
    
    case "merge":
      return "merge";
    
    case "skip":
      return "skip";
    
    default:
      return "remote";
  }
}

function importFromSync(data, options = {}) {
  if (!hasMemoriesTable()) return { imported: 0, skipped: 0, errors: ["memories table not found"] };
  if (!data || !Array.isArray(data.memories)) {
    return { imported: 0, skipped: 0, errors: ["invalid sync data: missing memories array"] };
  }
  
  const ts = nowIso();
  const localMachineId = getMachineId();
  const strategy = options.strategy || "newest";
  
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;
  const errors = [];
  
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const mem of data.memories) {
      if (!mem.type || !mem.content) {
        errors.push(`skipped: missing type or content`);
        skipped++;
        continue;
      }
      
      const existing = db.prepare(`
        SELECT * FROM memories
        WHERE type = ? AND COALESCE(project, '') = COALESCE(?, '') AND content = ?
        LIMIT 1
      `).get(mem.type, mem.project || null, mem.content);
      
      if (existing) {
        if (existing.origin_machine_id === localMachineId && mem.origin_machine_id === localMachineId) {
          skipped++;
          continue;
        }
        
        const resolution = resolveConflict(existing, mem, strategy);
        
        if (resolution === "skip") {
          skipped++;
          continue;
        }
        
        if (resolution === "local") {
          conflicts++;
          continue;
        }
        
        if (resolution === "merge") {
          const mergedMeta = {
            ...parseJson(existing.metadata_json, {}),
            ...mem.metadata,
            merged_at: ts,
            merge_source: "sync"
          };
          const mergedConfidence = Math.max(existing.confidence, mem.confidence);
          const mergedConfirmed = existing.times_confirmed + mem.times_confirmed;
          
          db.prepare(`
            UPDATE memories
            SET confidence = ?,
                times_confirmed = ?,
                metadata_json = ?,
                sync_version = sync_version + 1,
                last_synced_at = ?,
                updated_at = ?
            WHERE id = ?
          `).run(
            mergedConfidence,
            mergedConfirmed,
            JSON.stringify(mergedMeta),
            ts,
            ts,
            existing.id
          );
          conflicts++;
          continue;
        }
        
        const remoteMeta = {
          ...mem.metadata,
          synced_at: ts,
          sync_source: "remote",
          previous_local_id: existing.id
        };
        
        db.prepare(`
          UPDATE memories
          SET summary = ?,
              tags = ?,
              confidence = ?,
              source = ?,
              source_tool = ?,
              source_task_id = ?,
              source_ref = ?,
              metadata_json = ?,
              enabled = ?,
              times_confirmed = ?,
              last_seen_at = ?,
              last_confirmed_at = ?,
              origin_machine_id = ?,
              origin_user_id = ?,
              sync_version = ?,
              last_synced_at = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          mem.summary || mem.content,
          JSON.stringify(mem.tags || []),
          mem.confidence,
          mem.source || "sync",
          mem.source_tool || null,
          mem.source_task_id || null,
          mem.source_ref || null,
          JSON.stringify(remoteMeta),
          mem.enabled === false ? 0 : 1,
          mem.times_confirmed || 1,
          mem.last_seen_at || ts,
          mem.last_confirmed_at || ts,
          mem.origin_machine_id || data.machine_id,
          mem.origin_user_id || data.user_id,
          (mem.sync_version || 1) + 1,
          ts,
          ts,
          existing.id
        );
        conflicts++;
        continue;
      }
      
      const id = options.preserveIds && mem.id ? mem.id : `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const metadata = { ...mem.metadata, synced_at: ts, sync_source: "remote" };
      
      db.prepare(`
        INSERT INTO memories (
          id, type, project, content, summary, tags, confidence, source, source_tool,
          source_task_id, source_ref, metadata_json, enabled, automatic,
          times_confirmed, created_at, updated_at, last_seen_at, last_confirmed_at,
          expires_at, origin_machine_id, origin_user_id, sync_version, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        mem.type,
        mem.project || null,
        mem.content,
        mem.summary || mem.content,
        JSON.stringify(mem.tags || []),
        mem.confidence || 0.5,
        mem.source || "sync",
        mem.source_tool || null,
        mem.source_task_id || null,
        mem.source_ref || null,
        JSON.stringify(metadata),
        mem.enabled === false ? 0 : 1,
        mem.automatic === false ? 0 : 1,
        mem.times_confirmed || 1,
        mem.created_at || ts,
        ts,
        mem.last_seen_at || ts,
        mem.last_confirmed_at || ts,
        mem.expires_at || null,
        mem.origin_machine_id || data.machine_id,
        mem.origin_user_id || data.user_id,
        mem.sync_version || 1,
        ts
      );
      imported++;
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { imported, updated, skipped, conflicts, errors: [...errors, e.message] };
  }
  
  return { imported, updated, skipped, conflicts, errors };
}

function getSyncDiff(since, options = {}) {
  if (!hasMemoriesTable()) return { changes: [], since };
  
  const localMachineId = getMachineId();
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE updated_at > ?
    ORDER BY updated_at ASC
  `).all(since);
  
  const changes = rows.map(row => ({
    id: row.id,
    type: row.type,
    project: row.project,
    content: row.content,
    summary: row.summary,
    confidence: row.confidence,
    enabled: !!row.enabled,
    times_confirmed: row.times_confirmed,
    updated_at: row.updated_at,
    origin_machine_id: row.origin_machine_id,
    is_local: row.origin_machine_id === localMachineId || row.origin_machine_id === null
  }));
  
  return {
    machine_id: localMachineId,
    user_id: getUserId(),
    since,
    count: changes.length,
    changes
  };
}


function getDb() {
  return db;
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  BACKUP_DIR,
  MIGRATIONS_DIR,
  db,
  getDb,
  getDocument,
  setDocument,
  loadDocument,
  loadKV,
  clearKV,
  replaceKV,
  setKV,
  getKV,
  deleteKV,
  listKVProjects,
  getAllKV,
  appendToolLog,
  readToolLogs,
  clearToolLogs,
  hasMemoriesTable,
  upsertMemory,
  searchMemories,
  listMemories,
  disableMemory,
  trimAutomaticMemories,
  memorySimilarity,
  exportMemories,
  importMemories,
  expireStaleMemories,
  calculateMemoryDecay,
  getMemoryStats,
  getMachineId,
  getUserId,
  setUserId,
  exportForSync,
  importFromSync,
  getSyncDiff,
  resolveConflict,
  executeQuery,
  getTableList,
  getTableInfo,
  getDatabaseStats,
  createBackup,
  restoreBackup,
  queryToolLogs,
  exportTable,
  setupFTS5,
  searchAllTables,
  getMigrationVersion,
  runMigration,
  listMigrations,
  runPendingMigrations,
  createSnapshot,
  compareSnapshots,
};
