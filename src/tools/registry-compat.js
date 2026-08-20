"use strict";

const { stripSidekickPrefix } = require("../core/tool-name");
const { redactSensitive, isSensitiveKey, redactSensitiveKeysDeep } = require("../redact");

function createRegistryCompat({ dbStore, TOOL_DEFS, TOOL_CATEGORIES, getToolPolicyDecision, getApprovalDecision, getCurrentSource }) {
function getToolDefsForSource(source = getCurrentSource()) {
  try {
    const db = dbStore.getDb();

    // Check if tools table exists (fallback to in-memory if not)
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tools'"
    ).get();

    if (!tableExists) {
      // Fallback to in-memory TOOL_DEFS if DB not ready
      return TOOL_DEFS.map(def => {
        const policy = getToolPolicyDecision(def.name, source);
        const approval = getApprovalDecision(def.name, source);
        return { ...def, args: def.argumentDescriptions || def.args || {}, category: def.category || TOOL_CATEGORIES[def.name] || "Uncategorized", risk: policy.risk, enabled: policy.allowed, policy: policy.reason, approval_required: approval.required, approval: approval.reason };
      });
    }

    // Get all enabled, non-deprecated tools from database
    const tools = db.prepare(`
      SELECT t.name, t.description, t.args_json, t.risk, t.enabled,
             tc.name as category
      FROM tools t
      LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
      LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
      WHERE t.enabled = 1 AND t.deprecated = 0
      ORDER BY t.name
    `).all();

    // Intersect the DB catalog with the LIVE registry (builtin descriptors,
    // which include active module tools, plus trial/active generated
    // capabilities) the way src/agent.js's Brain allowlist does. The tools
    // table is a mirror synced at startup; between syncs it can hold rows for
    // tools that no longer exist in code, and a stale row must never be
    // advertised to any consumer as callable — the dispatcher would refuse it
    // anyway. Lazy require: the facade is fully initialized by the time this
    // runs, so no load-order cycle. If the live registry cannot be read the
    // filter is skipped (mirror-only behavior, as before) rather than hiding
    // everything.
    let liveNames = null;
    let liveDefinitions = null;
    try {
      // This file already lives in src/tools. Keep the lazy facade import so
      // module activation has completed, but resolve the canonical registry
      // from the correct sibling path. A wrong path here silently falls back
      // to the database's legacy args and strips schema constraints from the
      // Agent catalog.
      const liveDefs = require("./index").getBuiltinRegistry().toolDefs();
      liveNames = new Set(liveDefs.map(def => stripSidekickPrefix(def.name)));
      liveDefinitions = new Map(liveDefs.map(def => [stripSidekickPrefix(def.name), def]));
      for (const generated of dbStore.listGeneratedCapabilities({ states: ["trial", "active"] })) {
        liveNames.add(stripSidekickPrefix(generated.name));
      }
    } catch { liveNames = null; }

    return tools.filter(tool => !liveNames || liveNames.has(stripSidekickPrefix(tool.name))).map(tool => {
      const policy = getToolPolicyDecision(tool.name, source);
      const approval = getApprovalDecision(tool.name, source);
      const args = tool.args_json ? JSON.parse(tool.args_json) : {};

      const liveDef = liveDefinitions && liveDefinitions.get(stripSidekickPrefix(tool.name));
      return {
        name: tool.name,
        description: tool.description,
        args: liveDef?.argumentDescriptions || args,
        argumentDescriptions: liveDef?.argumentDescriptions || args,
        category: tool.category || TOOL_CATEGORIES[tool.name] || "Uncategorized",
        risk: policy.risk,
        enabled: policy.allowed,
        // Preserve semantic metadata from the same live canonical registry
        // that proved the tool exists. The database mirror has no authority
        // to invent Agent-facing capability labels.
        capabilities: liveDef?.capabilities || [],
        policy: policy.reason,
        approval_required: approval.required,
        approval: approval.reason
      };
    });
  } catch (error) {
    console.error('[ToolRegistry] Error reading from DB, falling back to in-memory:', error.message);
    // Fallback to in-memory if DB query fails
    return TOOL_DEFS.map(def => {
      const policy = getToolPolicyDecision(def.name, source);
      const approval = getApprovalDecision(def.name, source);
      return { ...def, args: def.argumentDescriptions || def.args || {}, category: def.category || TOOL_CATEGORIES[def.name] || "Uncategorized", risk: policy.risk, enabled: policy.allowed, policy: policy.reason, approval_required: approval.required, approval: approval.reason };
    });
  }
}

// Get all tool categories with their tools
function getToolCategoriesWithTools(source = getCurrentSource()) {
  try {
    const db = dbStore.getDb();

    // Check if tables exist
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_categories'"
    ).get();

    if (!tableExists) {
      // Return empty if DB not ready
      return [];
    }

    // Get all categories with sort order
    const categories = db.prepare(`
      SELECT id, name, icon, sort_order
      FROM tool_categories
      ORDER BY sort_order
    `).all();

    // Get all tools with their categories
    const tools = db.prepare(`
      SELECT t.name, t.description, t.risk, t.enabled, tc.name as category
      FROM tools t
      LEFT JOIN tool_category_map tcm ON t.name = tcm.tool_name
      LEFT JOIN tool_categories tc ON tcm.category_id = tc.id
      WHERE t.enabled = 1 AND t.deprecated = 0
      ORDER BY t.name
    `).all();

    // Group tools by category
    const categoryMap = {};
    for (const cat of categories) {
      categoryMap[cat.name] = {
        name: cat.name,
        icon: cat.icon,
        sort_order: cat.sort_order,
        tools: []
      };
    }

    for (const tool of tools) {
      const policy = getToolPolicyDecision(tool.name, source);
      const approval = getApprovalDecision(tool.name, source);
      if (tool.category && categoryMap[tool.category]) {
        categoryMap[tool.category].tools.push({
          name: tool.name,
          description: tool.description,
          risk: policy.risk,
          enabled: policy.allowed,
          approval_required: approval.required
        });
      }
    }

    // Return as array, filtering out empty categories
    return Object.values(categoryMap)
      .filter(cat => cat.tools.length > 0)
      .sort((a, b) => a.sort_order - b.sort_order);
  } catch (error) {
    console.error('[ToolRegistry] Error getting categories:', error.message);
    return [];
  }
}


function formatArgs(args) {
  if (typeof args !== "object" || args === null) return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    // redactSensitive only sees the bare value here; a credential under a
    // sensitive key name has no recognizable shape, so check the key first.
    if (isSensitiveKey(key)) {
      parts.push(key + "=[REDACTED]");
      continue;
    }
    // Objects/arrays are sanitized with key context before serialization:
    // String() loses their content and JSON quoting defeats redactSensitive.
    const str = value && typeof value === "object"
      ? JSON.stringify(redactSensitiveKeysDeep(value))
      : String(value);
    const truncated = str.length > 100 ? str.substring(0, 100) + "..." : str;
    parts.push(key + "=" + redactSensitive(truncated));
  }
  return parts.join(", ");
}

  return { getToolDefsForSource, getToolCategoriesWithTools, formatArgs };
}

module.exports = { createRegistryCompat };
