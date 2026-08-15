"use strict";

function createRegistrySyncCompat({ dbStore, TOOL_DEFS, TOOL_RISK, TOOL_CATEGORIES }) {
function syncToolRegistry() {
  try {
    const db = dbStore.getDb();
    const now = new Date().toISOString();

    // Check if tool_categories table exists (migration may not have run yet)
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_categories'"
    ).get();

    if (!tableExists) {
      console.log('[ToolRegistry] Tables not yet created, skipping sync');
      return;
    }

    // Get all current tools from code. Active module tools count as current
    // so the catalog shows them and does not mark them deprecated; provision
    // modules BEFORE calling this or their tools deprecate until the next sync.
    const moduleDefs = require("../modules/loader").getActiveDescriptors().map(d => ({
      name: d.name,
      description: d.description,
      args: d.args,
      risk: d.risk,
      category: d.category,
    }));
    const dynamicNames = new Set(dbStore.listGeneratedCapabilities({ states: ["trial", "active"] }).map(t => t.name));
    const codeTools = new Set([...TOOL_DEFS.map(t => t.name), ...moduleDefs.map(t => t.name), ...dynamicNames]);

    // Get all tools from database
    const dbTools = db.prepare("SELECT name, deprecated FROM tools").all();
    const dbToolNames = new Set(dbTools.map(t => t.name));

    // Upsert tools from code into database
    const upsertTool = db.prepare(`
      INSERT INTO tools (name, description, args_json, risk, enabled, deprecated, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        args_json = excluded.args_json,
        risk = excluded.risk,
        enabled = 1,
        deprecated = 0,
        updated_at = excluded.updated_at
    `);

    // Map category names to IDs
    const categoryMap = {};
    const categories = db.prepare("SELECT id, name FROM tool_categories").all();
    for (const cat of categories) {
      categoryMap[cat.name] = cat.id;
    }

    // Clear existing tool-category mappings (we'll recreate them)
    db.prepare("DELETE FROM tool_category_map").run();

    // Insert/update each tool (module descriptors carry their own risk and
    // category; legacy defs fall back to the static maps)
    for (const toolDef of [...TOOL_DEFS, ...moduleDefs]) {
      const risk = toolDef.risk || TOOL_RISK[toolDef.name] || "low";
      const argsJson = JSON.stringify(toolDef.args || {});

      upsertTool.run(
        toolDef.name,
        toolDef.description,
        argsJson,
        risk,
        now
      );

      // Get the tool's category
      const categoryName = toolDef.category || TOOL_CATEGORIES[toolDef.name];
      if (categoryName && categoryMap[categoryName]) {
        db.prepare(
          "INSERT INTO tool_category_map (tool_name, category_id) VALUES (?, ?)"
        ).run(toolDef.name, categoryMap[categoryName]);
      }
    }

    // Mark tools that exist in DB but not in code as deprecated
    for (const dbTool of dbTools) {
      if (!codeTools.has(dbTool.name) && !dbTool.deprecated) {
        db.prepare(
          "UPDATE tools SET deprecated = 1, enabled = 0, updated_at = ? WHERE name = ?"
        ).run(now, dbTool.name);
      }
    }

    dbStore.syncGeneratedToolRegistry();
    console.log(`[ToolRegistry] Synced ${TOOL_DEFS.length} built-in tools, ${moduleDefs.length} module tools, and ${dynamicNames.size} generated tools to database`);
  } catch (error) {
    console.error('[ToolRegistry] Error syncing tool registry:', error.message);
  }
}

  return { syncToolRegistry };
}

module.exports = { createRegistrySyncCompat };
