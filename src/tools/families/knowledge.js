"use strict";

// Knowledge tool family: knowledge.
//
// Extracted from src/tools-legacy.js. Depends only on the shared db store and
// zod — never on tools-legacy.js. Moved verbatim; risk (low) preserved from
// src/tools/metadata.js.

const { z } = require("zod");
const { getStaticToolRisk } = require("../metadata");
const toolContext = require("../context");
const dbStore = require("../../db");
const { loadProcedures } = require("../../core/procedures-store");
const { redactSensitiveKeysDeep } = require("../../redact");
const { requireCanonicalInvocation } = require("../read-authorization");
const authorization = require("../../core/authorization");
const projectAccess = require("../../core/project-access");
const { canonicalizeProjectName } = require("../../core/project-identity");

const MAX_KNOWLEDGE_PROVENANCE_BYTES = 16 * 1024;

function refreshKnowledgeFts() {
  if (typeof dbStore.rebuildKnowledgeFts === "function") dbStore.rebuildKnowledgeFts();
}

function json(value) {
  return JSON.stringify(redactSensitiveKeysDeep(value));
}

function recordKnowledgeMutation(existing, execution, action, at) {
  const principalId = execution.authIdentity?.principal_id;
  if (typeof principalId !== "string" || !principalId.trim() || principalId.length > 200) {
    throw new Error("Knowledge mutation requires a valid authenticated principal");
  }
  let prior = existing || {};
  if (typeof prior === "string") {
    if (Buffer.byteLength(prior, "utf8") > MAX_KNOWLEDGE_PROVENANCE_BYTES) throw new Error("Knowledge provenance exceeds its storage limit");
    try { prior = JSON.parse(prior); } catch { throw new Error("Knowledge provenance is invalid"); }
  }
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) prior = {};
  const history = Array.isArray(prior.mutation_history) ? prior.mutation_history.slice(-19) : [];
  const contextProject = typeof execution.project === "string" && execution.project.length <= 128
    ? execution.project
    : null;
  history.push({
    action,
    actor_principal_id: principalId.trim(),
    approval_id: execution.approvedExecution === true ? execution.approvalId || null : null,
    approved_by_principal_id: execution.approvedExecution === true ? principalId : null,
    at,
    source: execution.source || null,
    context_project: contextProject,
  });
  const serialized = json({ ...prior, mutation_history: history });
  if (Buffer.byteLength(serialized, "utf8") > MAX_KNOWLEDGE_PROVENANCE_BYTES) {
    throw new Error("Knowledge provenance exceeds its storage limit");
  }
  return serialized;
}

function knowledgeScope(execution, permission) {
  const identity = execution.authIdentity;
  const principalId = identity?.principal_id;
  const delegationId = identity?.delegation_id || identity?.delegationId || null;
  if (!principalId) return { error: "Knowledge access requires an authenticated principal" };
  const decision = authorization.authorize({
    principalId,
    permission: `knowledge.${permission}`,
    credentialScopes: identity.scopes,
    delegationId,
  });
  if (!decision.ok) return { error: `Knowledge ${permission} permission denied` };

  let scopedProject = null;
  if (execution.project) {
    try { scopedProject = canonicalizeProjectName(execution.project); }
    catch { return { error: "Knowledge project scope is invalid" }; }
    if (!scopedProject) return { error: "Knowledge project scope is invalid" };
    if (!projectAccess.hasProjectPermission(principalId, scopedProject, `knowledge.${permission}`, permission === "write" ? "write" : "read", identity.scopes, delegationId)) {
      return { error: "Knowledge project scope denied" };
    }
    if (permission === "write") {
      const project = require("../../platform/kernel").getProject(scopedProject);
      if (!project || project.state !== "active") return { error: "Knowledge writes require an active registered project" };
    }
  }
  const globalAccess = projectAccess.hasGlobalProjectAccess(principalId, identity.scopes, delegationId);
  if (permission === "write" && !scopedProject && !globalAccess) {
    return { error: "Global knowledge writes require project administration access or an authorized project scope" };
  }
  return { projectId: scopedProject, allProjects: !scopedProject && globalAccess };
}

function knowledgeRowInScope(row, scope, permission) {
  if (!row) return false;
  if (!row.project_id) return permission === "read" || scope.allProjects;
  return scope.allProjects || row.project_id === scope.projectId;
}

function knowledgeWhere(scope, alias = "") {
  const column = alias ? `${alias}.project_id` : "project_id";
  if (scope.allProjects) return { sql: "1 = 1", params: [] };
  if (scope.projectId) return { sql: `(${column} IS NULL OR ${column} = ?)`, params: [scope.projectId] };
  return { sql: `${column} IS NULL`, params: [] };
}

function promotedContent(sourceType, item) {
  const body = sourceType === "evolve"
    ? {
        kind: "evolved-capability",
        name: item.name,
        description: item.description,
        parameters: item.parameters || {},
        steps: item.steps || [],
        validation: item.validation || null,
        evidence: item.evidence || [],
      }
    : {
        kind: "taught-procedure",
        name: item.name,
        description: item.description,
        parameters: item.parameters || {},
        steps: item.steps || [],
        trigger_phrases: item.triggerPhrases || [],
      };
  return `Promoted ${sourceType} knowledge.\n\n${JSON.stringify(redactSensitiveKeysDeep(body), null, 2)}`;
}

function findPromotionSource(source, sourceId) {
  if (source === "evolve") {
    const item = dbStore.getGeneratedCapability(sourceId) || dbStore.getGeneratedCapabilityByName(sourceId);
    if (!item) return { error: `Evolve capability not found: ${sourceId}` };
    if (item.state !== "active") return { error: `Evolve capability must be active before knowledge promotion (current state: ${item.state})` };
    if ((item.successCount || 0) < 1) return { error: "Evolve capability must have a successful trial before knowledge promotion" };
    return { item, version: String(item.version || 1), id: item.id };
  }
  if (source === "procedure") {
    const item = loadProcedures()[sourceId];
    if (!item) return { error: `Taught procedure not found: ${sourceId}` };
    return { item, version: String(item.updatedAt || item.createdAt || "1"), id: sourceId };
  }
  return { error: "source must be evolve or procedure" };
}

// --- Knowledge Tool ---

async function sidekick_knowledge({ action, id, category, title, content, tags, query, limit, source, source_id }) {
  const denied = requireCanonicalInvocation("knowledge");
  if (denied) return denied;
  try {
    const db = dbStore.getDb();
    const execution = toolContext.getExecutionContext();
    const now = new Date().toISOString();

    if (action === "search") {
      if (!query) return { content: [{ type: "text", text: "Error: query is required for search" }], isError: true };
      const scope = knowledgeScope(execution, "read");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };
      const scopeWhere = knowledgeWhere(scope, "k");
      const searchLimit = limit || 10;

      const ftsQuery = query.trim().split(/\s+/).filter(Boolean)
        .map(term => `"${term.replace(/"/g, '""')}"`).join(" AND ");
      const categoryClause = category ? " AND k.category = ?" : "";
      const ftsParams = category
        ? [ftsQuery, category, ...scopeWhere.params, searchLimit]
        : [ftsQuery, ...scopeWhere.params, searchLimit];
      let rows;
      try {
        rows = db.prepare(`
          SELECT k.id, k.category, k.title, k.content, k.tags, k.updated_at
          FROM knowledge k
          JOIN knowledge_fts f ON f.rowid = k.id
          WHERE k.enabled = 1 AND knowledge_fts MATCH ?${categoryClause} AND ${scopeWhere.sql}
          ORDER BY bm25(knowledge_fts), k.updated_at DESC
          LIMIT ?
        `).all(...ftsParams);
      } catch (error) {
        const fallbackCategoryClause = category ? " AND category = ?" : "";
        const fallbackScope = knowledgeWhere(scope);
        rows = db.prepare(`
          SELECT id, category, title, content, tags, updated_at
          FROM knowledge
          WHERE enabled = 1 AND (
            title LIKE ? OR
            content LIKE ? OR
            tags LIKE ?
          )${fallbackCategoryClause} AND ${fallbackScope.sql}
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(`%${query}%`, `%${query}%`, `%${query}%`, ...(category ? [category] : []), ...fallbackScope.params, searchLimit);
      }

      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (action === "get") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for get" }], isError: true };
      const scope = knowledgeScope(execution, "read");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };
      const scopeWhere = knowledgeWhere(scope);
      const row = db.prepare(`
        SELECT id, category, title, content, tags, updated_at
        FROM knowledge
        WHERE id = ? AND enabled = 1 AND ${scopeWhere.sql}
      `).get(id, ...scopeWhere.params);

      if (!row) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    }

    if (action === "list") {
      const scope = knowledgeScope(execution, "read");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };
      const scopeWhere = knowledgeWhere(scope);
      const listLimit = limit || 50;
      let rows;

      if (category) {
        rows = db.prepare(`
          SELECT id, category, title, tags, updated_at
          FROM knowledge
          WHERE enabled = 1 AND category = ? AND ${scopeWhere.sql}
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(category, ...scopeWhere.params, listLimit);
      } else {
        rows = db.prepare(`
          SELECT id, category, title, tags, updated_at
          FROM knowledge
          WHERE enabled = 1 AND ${scopeWhere.sql}
          ORDER BY category, updated_at DESC
          LIMIT ?
        `).all(...scopeWhere.params, listLimit);
      }

      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (action === "add") {
      if (!category || !title || !content) {
        return { content: [{ type: "text", text: "Error: category, title, and content are required for add" }], isError: true };
      }

      const scope = knowledgeScope(execution, "write");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };
      const provenance = recordKnowledgeMutation(null, execution, "add", now);

      const result = db.prepare(`
        INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at, provenance_json, project_id)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(category, title, content, tags || '', now, now, provenance, scope.projectId);
      refreshKnowledgeFts();

      return { content: [{ type: "text", text: `Added knowledge entry with id: ${result.lastInsertRowid}` }] };
    }

    if (action === "promote") {
      if (!source || !source_id || !category) {
        return { content: [{ type: "text", text: "source, source_id, and category are required for promote" }], isError: true };
      }
      const scope = knowledgeScope(execution, "write");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };
      const verifiedApprover = execution.authIdentity?.principal_id || null;
      if (!execution.approvedExecution || !execution.approvalId || !verifiedApprover) {
        return { content: [{ type: "text", text: "Knowledge promotion requires an authenticated dispatcher approval" }], isError: true, code: "approval_required" };
      }
      const resolved = findPromotionSource(source, source_id);
      if (resolved.error) return { content: [{ type: "text", text: `Error: ${resolved.error}` }], isError: true };
      const promotedTitle = title || resolved.item.title || resolved.item.name;
      if (!promotedTitle) return { content: [{ type: "text", text: "Error: promoted source has no title or name" }], isError: true };
      const existing = db.prepare(`
        SELECT id FROM knowledge
        WHERE source_type = ? AND source_id = ? AND source_version = ? AND enabled = 1 AND project_id IS ?
        ORDER BY id DESC LIMIT 1
      `).get(source, resolved.id, resolved.version, scope.projectId);
      if (existing) {
        return { content: [{ type: "text", text: JSON.stringify({ promoted: false, existing_id: existing.id, source, source_id: resolved.id, source_version: resolved.version }, null, 2) }] };
      }
      const provenance = {
        source_type: source,
        source_id: resolved.id,
        source_version: resolved.version,
        approved_by: verifiedApprover,
        approved_at: now,
      };
      const storedProvenance = recordKnowledgeMutation(provenance, execution, "promote", now);
      const result = db.prepare(`
        INSERT INTO knowledge (
          category, title, content, tags, enabled, version_added, updated_at,
          source_type, source_id, source_version, provenance_json, approved_by, approved_at, project_id
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        category,
        promotedTitle,
        promotedContent(source, resolved.item),
        [tags, `source:${source}`].filter(Boolean).join(","),
        `promoted-${source}`,
        now,
        source,
        resolved.id,
        resolved.version,
        storedProvenance,
        verifiedApprover,
        now,
        scope.projectId,
      );
      refreshKnowledgeFts();
      return { content: [{ type: "text", text: JSON.stringify({ promoted: true, id: result.lastInsertRowid, source, source_id: resolved.id, source_version: resolved.version, approved_by: verifiedApprover }, null, 2) }] };
    }

    if (action === "update") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
      const scope = knowledgeScope(execution, "write");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };

      const updates = [];
      const params = [];

      if (category !== undefined) { updates.push("category = ?"); params.push(category); }
      if (title !== undefined) { updates.push("title = ?"); params.push(title); }
      if (content !== undefined) { updates.push("content = ?"); params.push(content); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(tags); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "Error: at least one field to update is required" }], isError: true };
      }

      const updated = db.transaction(() => {
        const current = db.prepare("SELECT project_id, provenance_json FROM knowledge WHERE id = ? AND enabled = 1").get(id);
        if (!knowledgeRowInScope(current, scope, "write")) return false;
        const provenance = recordKnowledgeMutation(current.provenance_json, toolContext.getExecutionContext(), "update", now);
        const updateFields = [...updates, "provenance_json = ?", "updated_at = ?"];
        return db.prepare(`UPDATE knowledge SET ${updateFields.join(", ")} WHERE id = ? AND enabled = 1`)
          .run(...params, provenance, now, id).changes > 0;
      })();
      if (!updated) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
      refreshKnowledgeFts();

      return { content: [{ type: "text", text: `Updated knowledge entry ${id}` }] };
    }

    if (action === "delete") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
      const scope = knowledgeScope(execution, "write");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };
      const deleted = db.transaction(() => {
        const current = db.prepare("SELECT project_id, provenance_json FROM knowledge WHERE id = ? AND enabled = 1").get(id);
        if (!knowledgeRowInScope(current, scope, "write")) return false;
        const provenance = recordKnowledgeMutation(current.provenance_json, toolContext.getExecutionContext(), "delete", now);
        return db.prepare("UPDATE knowledge SET enabled = 0, updated_at = ?, provenance_json = ? WHERE id = ? AND enabled = 1")
          .run(now, provenance, id).changes > 0;
      })();
      if (!deleted) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
      refreshKnowledgeFts();
      return { content: [{ type: "text", text: `Soft-deleted knowledge entry ${id}` }] };
    }

    if (action === "purge") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for purge" }], isError: true };
      const scope = knowledgeScope(execution, "write");
      if (scope.error) return { content: [{ type: "text", text: `Error: ${scope.error}` }], isError: true, code: "forbidden" };
      const row = db.prepare("SELECT id, enabled, project_id FROM knowledge WHERE id = ?").get(id);
      if (!knowledgeRowInScope(row, scope, "write")) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
      if (row.enabled) {
        return { content: [{ type: "text", text: "Error: purge only removes disabled entries. Run action=delete first to soft-delete the entry." }], isError: true };
      }
      db.prepare("DELETE FROM knowledge WHERE id = ? AND enabled = 0").run(id);
      refreshKnowledgeFts();
      return { content: [{ type: "text", text: `Purged disabled knowledge entry ${id}` }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: search, get, list, add, promote, update, delete, purge" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

const SCHEMAS = {
  knowledge: z.object({
    action: z.enum(["search", "get", "list", "add", "promote", "update", "delete", "purge"]).describe("Knowledge base action"),
    id: z.number().optional().describe("Entry ID (for get/update/delete)"),
    category: z.string().optional().describe("Category (for list/add/promote/update)"),
    title: z.string().optional().describe("Title (for add/promote/update)"),
    content: z.string().optional().describe("Content (for add/update)"),
    tags: z.string().optional().describe("Comma-separated tags (for add/update)"),
    query: z.string().optional().describe("Search query (for search)"),
    limit: z.number().optional().describe("Max results (for search/list)"),
    source: z.enum(["evolve", "procedure"]).optional().describe("Promotion source type"),
    source_id: z.string().optional().describe("Generated capability ID/name or taught procedure name"),
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "knowledge",
    description: "Knowledge base management: search, get, list, add, promote reviewed evolved/taught knowledge, update, soft-delete, and purge disabled entries",
    schema: SCHEMAS.knowledge,
    args: { action: "string (search|get|list|add|promote|update|delete|purge)", id: "number (optional, entry ID for get/update/delete/purge)", category: "string (optional, category for list/add/promote/update)", title: "string (optional, title for add/promote/update)", content: "string (optional, content for add/update)", tags: "string (optional, comma-separated tags for add/promote/update)", query: "string (optional, search query for search)", limit: "number (optional, max results for search/list)", source: "string (optional, evolve or procedure for promote)", source_id: "string (optional, source capability/procedure ID for promote)" },
    risk: getStaticToolRisk("knowledge"),
    category: "Context & Learning",
    source: "builtin",
    family: "knowledge",
    handler: sidekick_knowledge,
  }),
]);

module.exports = { descriptors, sidekick_knowledge };
