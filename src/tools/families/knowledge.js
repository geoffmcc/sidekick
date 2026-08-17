"use strict";

// Knowledge tool family: knowledge.
//
// Extracted from src/tools-legacy.js. Depends only on the shared db store and
// zod — never on tools-legacy.js. Moved verbatim; risk (low) preserved from
// src/tools/metadata.js.

const { z } = require("zod");
const dbStore = require("../../db");
const { loadProcedures } = require("../../core/procedures-store");
const { redactSensitiveKeysDeep } = require("../../redact");

function refreshKnowledgeFts() {
  if (typeof dbStore.rebuildKnowledgeFts === "function") dbStore.rebuildKnowledgeFts();
}

function json(value) {
  return JSON.stringify(redactSensitiveKeysDeep(value));
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

async function sidekick_knowledge({ action, id, category, title, content, tags, query, limit, source, source_id, approver }) {
  try {
    const db = dbStore.getDb();
    const now = new Date().toISOString();

    if (action === "search") {
      if (!query) return { content: [{ type: "text", text: "Error: query is required for search" }], isError: true };
      const searchLimit = limit || 10;

      const ftsQuery = query.trim().split(/\s+/).filter(Boolean)
        .map(term => `"${term.replace(/"/g, '""')}"`).join(" AND ");
      const categoryClause = category ? " AND k.category = ?" : "";
      const ftsParams = category ? [ftsQuery, category, searchLimit] : [ftsQuery, searchLimit];
      let rows;
      try {
        rows = db.prepare(`
          SELECT k.id, k.category, k.title, k.content, k.tags, k.updated_at
          FROM knowledge k
          JOIN knowledge_fts f ON f.rowid = k.id
          WHERE k.enabled = 1 AND knowledge_fts MATCH ?${categoryClause}
          ORDER BY bm25(knowledge_fts), k.updated_at DESC
          LIMIT ?
        `).all(...ftsParams);
      } catch (error) {
        const fallbackCategoryClause = category ? " AND category = ?" : "";
        const fallbackParams = category
          ? [`%${query}%`, `%${query}%`, `%${query}%`, category, searchLimit]
          : [`%${query}%`, `%${query}%`, `%${query}%`, searchLimit];
        rows = db.prepare(`
          SELECT id, category, title, content, tags, updated_at
          FROM knowledge
          WHERE enabled = 1 AND (
            title LIKE ? OR
            content LIKE ? OR
            tags LIKE ?
          )${fallbackCategoryClause}
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(...fallbackParams);
      }

      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (action === "get") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for get" }], isError: true };
      const row = db.prepare(`
        SELECT id, category, title, content, tags, updated_at
        FROM knowledge
        WHERE id = ? AND enabled = 1
      `).get(id);

      if (!row) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    }

    if (action === "list") {
      const listLimit = limit || 50;
      let rows;

      if (category) {
        rows = db.prepare(`
          SELECT id, category, title, tags, updated_at
          FROM knowledge
          WHERE enabled = 1 AND category = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(category, listLimit);
      } else {
        rows = db.prepare(`
          SELECT id, category, title, tags, updated_at
          FROM knowledge
          WHERE enabled = 1
          ORDER BY category, updated_at DESC
          LIMIT ?
        `).all(listLimit);
      }

      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (action === "add") {
      if (!category || !title || !content) {
        return { content: [{ type: "text", text: "Error: category, title, and content are required for add" }], isError: true };
      }

      const result = db.prepare(`
        INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(category, title, content, tags || '', now, now);
      refreshKnowledgeFts();

      return { content: [{ type: "text", text: `Added knowledge entry with id: ${result.lastInsertRowid}` }] };
    }

    if (action === "promote") {
      if (!source || !source_id || !category || !approver) {
        return { content: [{ type: "text", text: "source, source_id, category, and approver are required for promote" }], isError: true };
      }
      const resolved = findPromotionSource(source, source_id);
      if (resolved.error) return { content: [{ type: "text", text: `Error: ${resolved.error}` }], isError: true };
      const promotedTitle = title || resolved.item.title || resolved.item.name;
      if (!promotedTitle) return { content: [{ type: "text", text: "Error: promoted source has no title or name" }], isError: true };
      const existing = db.prepare(`
        SELECT id FROM knowledge
        WHERE source_type = ? AND source_id = ? AND source_version = ? AND enabled = 1
        ORDER BY id DESC LIMIT 1
      `).get(source, resolved.id, resolved.version);
      if (existing) {
        return { content: [{ type: "text", text: JSON.stringify({ promoted: false, existing_id: existing.id, source, source_id: resolved.id, source_version: resolved.version }, null, 2) }] };
      }
      const provenance = {
        source_type: source,
        source_id: resolved.id,
        source_version: resolved.version,
        approved_by: String(approver),
        approved_at: now,
      };
      const result = db.prepare(`
        INSERT INTO knowledge (
          category, title, content, tags, enabled, version_added, updated_at,
          source_type, source_id, source_version, provenance_json, approved_by, approved_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
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
        json(provenance),
        String(approver),
        now,
      );
      refreshKnowledgeFts();
      return { content: [{ type: "text", text: JSON.stringify({ promoted: true, id: result.lastInsertRowid, source, source_id: resolved.id, source_version: resolved.version, approved_by: String(approver) }, null, 2) }] };
    }

    if (action === "update") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };

      const updates = [];
      const params = [];

      if (category !== undefined) { updates.push("category = ?"); params.push(category); }
      if (title !== undefined) { updates.push("title = ?"); params.push(title); }
      if (content !== undefined) { updates.push("content = ?"); params.push(content); }
      if (tags !== undefined) { updates.push("tags = ?"); params.push(tags); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "Error: at least one field to update is required" }], isError: true };
      }

      updates.push("updated_at = ?");
      params.push(now);
      params.push(id);

      db.prepare(`UPDATE knowledge SET ${updates.join(", ")} WHERE id = ? AND enabled = 1`).run(...params);
      refreshKnowledgeFts();

      return { content: [{ type: "text", text: `Updated knowledge entry ${id}` }] };
    }

    if (action === "delete") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
      db.prepare("UPDATE knowledge SET enabled = 0, updated_at = ? WHERE id = ?").run(now, id);
      refreshKnowledgeFts();
      return { content: [{ type: "text", text: `Soft-deleted knowledge entry ${id}` }] };
    }

    if (action === "purge") {
      if (!id) return { content: [{ type: "text", text: "Error: id is required for purge" }], isError: true };
      const row = db.prepare("SELECT id, enabled FROM knowledge WHERE id = ?").get(id);
      if (!row) return { content: [{ type: "text", text: "Error: knowledge entry not found" }], isError: true };
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
    approver: z.string().optional().describe("Explicit human/operator approver for promotion")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "knowledge",
    description: "Knowledge base management: search, get, list, add, promote reviewed evolved/taught knowledge, update, soft-delete, and purge disabled entries",
    schema: SCHEMAS.knowledge,
    args: { action: "string (search|get|list|add|promote|update|delete|purge)", id: "number (optional, entry ID for get/update/delete/purge)", category: "string (optional, category for list/add/promote/update)", title: "string (optional, title for add/promote/update)", content: "string (optional, content for add/update)", tags: "string (optional, comma-separated tags for add/promote/update)", query: "string (optional, search query for search)", limit: "number (optional, max results for search/list)", source: "string (optional, evolve or procedure for promote)", source_id: "string (optional, source capability/procedure ID for promote)", approver: "string (optional, explicit approver for promote)" },
    risk: "low",
    category: "Context & Learning",
    source: "builtin",
    family: "knowledge",
    handler: sidekick_knowledge,
  }),
]);

module.exports = { descriptors, sidekick_knowledge };
