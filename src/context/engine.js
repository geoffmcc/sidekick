"use strict";

const crypto = require("crypto");
const dbStoreDefault = require("../db");
const { redactSensitive } = require("../redact");
const { authorizeScope, sourceAllowed } = require("./scope");
const { lexicalScore, rankEntry } = require("./ranking");

const MAX_QUERY_CHARS = 2000;
const MAX_ENTRY_CHARS = 1800;
const MAX_RECEIPT_ENTRIES = 100;
const DEFAULT_BUDGET = Object.freeze({ maxEntries: 24, maxChars: 18000, maxPerSource: 8, maxGraphDepth: 1, maxGraphNodes: 12, maxGraphEdges: 24 });

function digest(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function clamp(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function safeText(value, max = MAX_ENTRY_CHARS) { return redactSensitive(String(value == null ? "" : value)).slice(0, max); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function searchText(item) { return [item.title, item.category, item.type, item.project, item.summary, item.content, item.tags, item.entityName, item.relationType].filter(Boolean).join(" "); }

function lifecycleExcluded(item) {
  return item.enabled === false || item.state === "deleted" || item.state === "disabled" || item.state === "expired" || item.current === false || !!item.superseded;
}

function normalizeMemory(row) {
  return {
    source: "memory", sourceId: row.id, type: row.type || row.memory_class || "memory",
    project: row.project || row.primary_scope_id || null, summary: row.summary || row.content,
    content: row.content, confidence: row.confidence, sourceAuthority: row.source_authority,
    authority: row.source_type || row.source, createdAt: row.created_at, updatedAt: row.updated_at,
    observedAt: row.observed_at || row.last_seen_at, revalidateAfter: row.revalidate_after,
    expiresAt: row.expires_at, current: row.current, enabled: row.enabled, state: row.state,
    superseded: !!row.supersedes_id || parseJson(row.metadata_json, {}).state === "superseded",
    conflictGroup: row.conflict_group, provenance: { source: row.source, sourceTool: row.source_tool, sourceRef: row.source_ref },
    searchText: searchText(row),
  };
}

function normalizeKnowledge(row) {
  return {
    source: "knowledge", sourceId: String(row.id), type: "knowledge", project: null,
    title: row.title, category: row.category, summary: row.title, content: row.content,
    tags: row.tags, confidence: 0.9, authority: row.source_type || "curated",
    createdAt: row.version_added, updatedAt: row.updated_at,
    provenance: { category: row.category, sourceType: row.source_type || "curated", sourceId: row.source_id || null },
    searchText: searchText(row),
  };
}

function normalizeHandoff(row) {
  return {
    source: "handoff", sourceId: row.id, type: "handoff", project: row.project,
    summary: row.title || row.redacted_content, content: row.redacted_content || row.content,
    confidence: 0.8, authority: "handoff", createdAt: row.created_at, updatedAt: row.updated_at,
    state: row.archived_at ? "archived" : "active", provenance: { source: row.source, taskId: row.task_id, version: row.version },
    searchText: searchText(row),
  };
}

function normalizeSession(row) {
  return {
    source: "session", sourceId: row.id, type: "session", project: row.project,
    summary: row.final_summary || row.goal, content: row.final_summary || row.goal,
    confidence: 0.72, authority: "historical", createdAt: row.created_at, updatedAt: row.updated_at,
    state: row.state, provenance: { source: row.source, branch: row.branch, repository: row.repository },
    searchText: searchText(row),
  };
}

function createContextEngine({ dbStore = dbStoreDefault, db = dbStoreDefault.getDb(), now = () => Date.now(), repositorySemanticSearch = null } = {}) {
  let semanticSearch = null;
  try { semanticSearch = require("../memory").searchMemoriesByEmbedding; } catch {}
  function scopedRows(project, includeGlobal = false) {
    if (!project) return includeGlobal ? [null, "global"] : [];
    return [project];
  }

  function queryKnowledge(query, limit) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge'").get()) return [];
    const terms = String(query || "").trim().split(/\s+/).filter(Boolean).slice(0, 12);
    // OR is deliberate here: relevance/ranking performs the final matching.
    // Requiring every request token makes a useful hybrid search impossible
    // for natural-language questions containing stop words or live-state
    // qualifiers that are absent from a curated entry.
    const fts = terms.map(term => `"${term.replace(/"/g, "\"\"").slice(0, 80)}"`).join(" OR ");
    try {
      return db.prepare(`SELECT k.id, k.category, k.title, k.content, k.tags, k.updated_at, k.version_added, k.source_type, k.source_id FROM knowledge k JOIN knowledge_fts f ON f.rowid = k.id WHERE k.enabled = 1 AND knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts), k.updated_at DESC LIMIT ?`).all(fts || "\"\"", limit).map(normalizeKnowledge);
    } catch {
      const like = `%${String(query || "").slice(0, 200)}%`;
      return db.prepare("SELECT id, category, title, content, tags, updated_at, version_added, source_type, source_id FROM knowledge WHERE enabled = 1 AND (title LIKE ? OR content LIKE ? OR tags LIKE ?) ORDER BY updated_at DESC LIMIT ?").all(like, like, like, limit).map(normalizeKnowledge);
    }
  }

  function queryMemories(project, query, limit) {
    if (!project || !dbStore.searchMemories) return [];
    // Fetch only the authorized project slice first; lexical ranking belongs
    // to the Context Engine, not to an unscoped LIKE predicate.
    return dbStore.searchMemories({ project, type: "all", limit: Math.min(100, limit * 8) }).map(normalizeMemory);
  }

  function queryLegacyContext(project, query, limit) {
    if (!project || !dbStore.loadDocument) return [];
    const ctx = dbStore.loadDocument("context", { decisions: [], problems: [], patterns: [], sessions: [], memories: [] });
    const collections = [
      ["decisions", "decision", item => `${item.context || ""} ${item.decision || ""} ${item.reasoning || ""}`],
      ["problems", "problem", item => `${item.description || ""} ${item.solution || ""}`],
      ["patterns", "pattern", item => `${item.description || ""} ${item.example || ""}`],
      ["sessions", "session", item => `${item.summary || ""} ${(item.topics || []).join(" ")} ${item.notes || ""}`],
      ["memories", "memory", item => `${item.summary || ""} ${item.goal || ""} ${item.tool || ""}`],
    ];
    const out = [];
    for (const [key, type, text] of collections) for (const item of (ctx[key] || [])) {
      if (item.project !== project || item.enabled === false || item.state === "deleted" || item.state === "expired") continue;
      out.push({ source: "legacy_context", sourceId: item.id, type, project, summary: item.summary || item.decision || item.description, content: item.content || text(item), confidence: item.confidence || 0.5, authority: "historical", createdAt: item.date, updatedAt: item.updated_at || item.date, provenance: { legacy: true }, searchText: text(item) });
    }
    return out.sort((a, b) => lexicalScore(query, b.searchText) - lexicalScore(query, a.searchText)).slice(0, limit);
  }

  function queryExact(project, query, allowOpaqueId = false) {
    if ((!project && !allowOpaqueId) || !query) return [];
    const exact = [];
    if (dbStore.getMemoryById) {
      const memory = dbStore.getMemoryById(String(query), { includeDisabled: true });
      if (memory && (project ? memory.project === project : allowOpaqueId)) {
        const normalized = normalizeMemory(memory);
        if (!project) normalized.provenance = { ...(normalized.provenance || {}), scopeResolvedFromOpaqueId: true };
        exact.push(normalized);
      }
    }
    if (dbStore.loadDocument) {
      const ctx = dbStore.loadDocument("context", { decisions: [], problems: [], patterns: [], sessions: [], memories: [] });
      for (const key of ["decisions", "problems", "patterns", "sessions", "memories"]) {
        const item = (ctx[key] || []).find(candidate => candidate && candidate.id === query && (!project || candidate.project === project));
        if (item && (!project || item.project === project)) exact.push({ source: "legacy_context", sourceId: item.id, type: key === "memories" ? "memory" : key.slice(0, -1), project: item.project || null, summary: item.summary || item.decision || item.description, content: item.content || item.summary || item.decision || item.description, confidence: item.confidence || 0.5, authority: "historical", createdAt: item.date, updatedAt: item.updated_at || item.date, enabled: item.enabled, state: item.state, provenance: { legacy: true, exact: true, scopeResolvedFromOpaqueId: !project }, searchText: searchText(item) });
      }
    }
    return exact;
  }

  function queryHandoffs(project, limit) { return project && dbStore.listHandoffs ? dbStore.listHandoffs({ project, limit }).map(normalizeHandoff) : []; }
  function querySessions(project, limit) { return project && dbStore.listTaskSessions ? dbStore.listTaskSessions({ project, limit }).map(normalizeSession) : []; }

  async function querySemanticMemories(project, query, limit) {
    if (!project || typeof semanticSearch !== "function") return [];
    try {
      const rows = await semanticSearch(query, { project, limit: Math.min(20, limit) });
      return rows.map(row => ({ ...normalizeMemory(row), semanticScore: Number(row.score) || 0, provenance: { ...(normalizeMemory(row).provenance || {}), retrieval: "compute_qdrant" } }));
    } catch {
      // Vector retrieval is an optional relevance source. Its failure must not
      // weaken SQLite scope enforcement or make the task fail.
      return [];
    }
  }

  function queryArtifacts(project, limit) {
    if (!project || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_artifacts'").get()) return [];
    return db.prepare("SELECT artifact_id, type, name, project_id, producer, content_hash, created_at, sensitivity, redaction_state, metadata_json FROM platform_artifacts WHERE deleted_at IS NULL AND project_id = ? ORDER BY created_at DESC LIMIT ?").all(project, limit).map(row => ({
      source: "artifact", sourceId: row.artifact_id, type: "artifact", project, summary: row.name, content: row.name,
      confidence: 0.86, authority: "verified", createdAt: row.created_at, updatedAt: row.created_at,
      provenance: { producer: row.producer, contentHash: row.content_hash, sensitivity: row.sensitivity, redactionState: row.redaction_state },
      searchText: searchText(row),
    }));
  }

  function queryEntities(project, query, budget) {
    if (!project || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_entities'").get()) return { entries: [], excluded: [] };
    const entities = db.prepare("SELECT * FROM memory_entities WHERE active = 1 AND (primary_scope_id = ? OR primary_scope_id IS NULL) ORDER BY last_verified_at DESC LIMIT ?").all(project, Math.max(budget.maxGraphNodes * 4, budget.maxGraphNodes));
    const matchingEntities = entities.filter(row => lexicalScore(query, `${row.canonical_name} ${row.aliases_json}`) > 0).slice(0, budget.maxGraphNodes);
    const ids = new Set(matchingEntities.map(row => row.id));
    const relations = ids.size ? db.prepare(`SELECT r.*, f.canonical_name AS from_name, t.canonical_name AS to_name FROM memory_relationships r JOIN memory_entities f ON f.id = r.from_entity_id JOIN memory_entities t ON t.id = r.to_entity_id WHERE r.active = 1 AND (r.scope_id = ? OR r.scope_id IS NULL) AND r.from_entity_id IN (${Array.from(ids).map(() => "?").join(",")}) LIMIT ?`).all(project, ...ids, budget.maxGraphEdges) : [];
    const entries = [];
    for (const row of matchingEntities) entries.push({ source: "entity", sourceId: row.id, type: "entity", project, entityName: row.canonical_name, summary: row.canonical_name, content: row.canonical_name, confidence: 0.7, authority: row.last_verified_at ? "verified" : "derived", createdAt: row.created_at, updatedAt: row.updated_at, provenance: parseJson(row.provenance_json, {}), searchText: `${row.canonical_name} ${row.aliases_json}` });
    for (const row of relations) entries.push({ source: "relationship", sourceId: row.id, type: "relationship", project, summary: `${row.from_name} ${row.relation_type} ${row.to_name}`, content: `${row.from_name} ${row.relation_type} ${row.to_name}`, confidence: 0.72, authority: row.evidence_id ? "verified" : "derived", createdAt: row.created_at, updatedAt: row.updated_at, provenance: { evidenceId: row.evidence_id, scope: row.scope_id }, searchText: `${row.from_name} ${row.relation_type} ${row.to_name}` });
    return { entries, excluded: [] };
  }

  function persistReceipt(receipt) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_receipts'").get()) return null;
    const id = `ctx_${digest(`${receipt.queryDigest}|${receipt.createdAt}|${receipt.project || ""}`).slice(0, 24)}`;
    db.prepare("INSERT OR REPLACE INTO context_receipts (id, query_digest, project, principal_id, session_id, task_id, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, receipt.queryDigest, receipt.project || null, receipt.principalId || null, receipt.sessionId || null, receipt.taskId || null, JSON.stringify(receipt), receipt.createdAt);
    return id;
  }

  async function assemble(input = {}) {
    const query = safeText(input.query, MAX_QUERY_CHARS).trim();
    if (!query) throw new Error("context_query_required");
    const scope = authorizeScope({ project: input.project, principalId: input.principalId, allowedProjects: input.allowedProjects, requireProject: !!input.requireProject });
    const budget = { ...DEFAULT_BUDGET, ...(input.budget || {}) };
    budget.maxEntries = clamp(budget.maxEntries, 1, 100, DEFAULT_BUDGET.maxEntries);
    budget.maxChars = clamp(budget.maxChars, 1000, 100000, DEFAULT_BUDGET.maxChars);
    budget.maxPerSource = clamp(budget.maxPerSource, 1, 50, DEFAULT_BUDGET.maxPerSource);
    budget.maxGraphNodes = clamp(budget.maxGraphNodes, 0, 50, DEFAULT_BUDGET.maxGraphNodes);
    budget.maxGraphEdges = clamp(budget.maxGraphEdges, 0, 100, DEFAULT_BUDGET.maxGraphEdges);
    const excluded = [];
    const semanticProvider = typeof input.repositorySemanticSearch === "function" ? input.repositorySemanticSearch : repositorySemanticSearch;
    if (!scope.ok) excluded.push({ source: "scope", sourceId: scope.project, reasonCodes: [scope.code] });
    const candidates = [];
    const add = (source, rows) => {
      if (!sourceAllowed(source, input.permittedSources)) return;
      let count = 0;
      for (const row of rows || []) {
        if (count >= budget.maxPerSource) break;
        const opaqueExact = input.allowOpaqueId === true && row.provenance?.scopeResolvedFromOpaqueId === true;
        if (row.project && row.project !== scope.project && !opaqueExact) { excluded.push({ source, sourceId: row.sourceId, reasonCodes: ["WRONG_PROJECT_EXCLUDED"] }); continue; }
        if (lifecycleExcluded(row)) { excluded.push({ source, sourceId: row.sourceId, reasonCodes: [row.superseded ? "SUPERSEDED_EXCLUDED" : "EXPIRED_EXCLUDED"] }); continue; }
        candidates.push(row); count++;
      }
    };
    add("knowledge", queryKnowledge(query, budget.maxPerSource * 3));
    if (typeof semanticProvider === "function") {
      try { add("repository_semantic", await semanticProvider(query, { limit: budget.maxPerSource, maxChars: Math.min(6000, budget.maxChars) })); }
      catch (error) { excluded.push({ source: "repository_semantic", sourceId: null, reasonCodes: ["SEMANTIC_RETRIEVAL_FAILED"] }); }
    }
    if (scope.ok) {
      const exact = queryExact(scope.project, query, input.allowOpaqueId === true);
      add("memory", exact.filter(item => item.source === "memory"));
      add("legacy_context", exact.filter(item => item.source === "legacy_context"));
      add("memory", queryMemories(scope.project, query, budget.maxPerSource));
      add("memory", await querySemanticMemories(scope.project, query, budget.maxPerSource));
      add("legacy_context", queryLegacyContext(scope.project, query, budget.maxPerSource));
      add("handoff", queryHandoffs(scope.project, budget.maxPerSource));
      add("session", querySessions(scope.project, budget.maxPerSource));
      add("artifact", queryArtifacts(scope.project, budget.maxPerSource));
      const graph = queryEntities(scope.project, query, budget);
      add("entity", graph.entries.filter(item => item.source === "entity"));
      add("relationship", graph.entries.filter(item => item.source === "relationship"));
    } else {
      for (const source of ["memory", "legacy_context", "handoff", "session", "artifact", "entity", "relationship"]) if (sourceAllowed(source, input.permittedSources)) excluded.push({ source, sourceId: null, reasonCodes: ["PROJECT_SCOPE_REQUIRED"] });
    }
    const byIdentity = new Map();
    for (const item of candidates) {
      const rankedItem = rankEntry(query, { ...item, searchText: item.searchText || searchText(item) }, now());
      const key = `${rankedItem.source}:${rankedItem.sourceId}`;
      const prior = byIdentity.get(key);
      if (!prior || rankedItem.score > prior.score) byIdentity.set(key, rankedItem);
    }
    const ranked = Array.from(byIdentity.values()).sort((a, b) => b.score - a.score || String(a.sourceId).localeCompare(String(b.sourceId)));
    const entries = [];
    let chars = 0;
    const sourceCounts = new Map();
    for (const item of ranked) {
      const sourceCount = sourceCounts.get(item.source) || 0;
      const content = safeText(item.content || item.summary, MAX_ENTRY_CHARS);
      if (sourceCount >= budget.maxPerSource || entries.length >= budget.maxEntries) { excluded.push({ source: item.source, sourceId: item.sourceId, reasonCodes: ["CONTEXT_BUDGET_EXCLUDED"] }); continue; }
      if (chars + content.length > budget.maxChars) { excluded.push({ source: item.source, sourceId: item.sourceId, reasonCodes: ["CONTEXT_BUDGET_EXCLUDED"] }); continue; }
      chars += content.length; sourceCounts.set(item.source, sourceCount + 1);
      entries.push({ source: item.source, sourceId: item.sourceId, type: item.type, project: item.project || null, content, summary: safeText(item.summary || content, 500), provenance: item.provenance || {}, authority: item.authorityScore, confidence: item.confidence, freshness: item.freshnessScore, relevance: item.relevance, score: item.score, reasonCodes: item.reasonCodes, liveValidationRequired: item.liveValidationRequired, conflictState: item.conflictGroup ? "conflict" : "none" });
    }
    const validation = entries.filter(item => item.liveValidationRequired).map(item => ({ source: item.source, sourceId: item.sourceId, reason: "STALE_REQUIRES_VALIDATION" }));
    const createdAt = new Date(now()).toISOString();
    const receipt = { queryDigest: digest(query), project: scope.project, principalId: input.principalId || null, sessionId: input.sessionId || null, taskId: input.taskId || null, included: entries.map(item => ({ source: item.source, sourceId: item.sourceId, reasonCodes: item.reasonCodes })), excluded: excluded.slice(0, MAX_RECEIPT_ENTRIES), validationRequired: validation, createdAt };
    const receiptId = persistReceipt(receipt);
    return { version: 1, query, queryDigest: receipt.queryDigest, scope, budget, entries, validationRequired: validation, receipt: { id: receiptId, included: receipt.included, excluded: receipt.excluded }, createdAt };
  }

  return Object.freeze({ assemble, persistReceipt });
}

module.exports = { createContextEngine, DEFAULT_BUDGET };
