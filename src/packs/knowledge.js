"use strict";

/**
 * Pack knowledge assets.
 *
 * Knowledge is installed into the EXISTING knowledge store (the `knowledge`
 * table the `knowledge` tool serves), not into a pack-private table — an agent
 * asking `knowledge action="search"` must find pack knowledge the same way it
 * finds everything else.
 *
 * Ownership is recorded as a tag so pack rows are identifiable, and the pack
 * component row keeps the primary key so disable/upgrade/uninstall act on
 * exactly the rows the pack installed and nothing else.
 */

const fs = require("fs");
const dbStore = require("../db");

function ownerTag(packName) {
  return `pack:${packName}`;
}

function tagString(packName, tags = []) {
  return [...new Set([ownerTag(packName), ...tags])].join(",");
}

function refreshKnowledgeFts() {
  if (typeof dbStore.rebuildKnowledgeFts === "function") dbStore.rebuildKnowledgeFts();
}

/** Insert or update one knowledge asset, returning its row id. */
function installAsset(packName, packVersion, asset, filePath) {
  const db = dbStore.getDb();
  const content = fs.readFileSync(filePath, "utf-8");
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id, tags FROM knowledge WHERE category = ? AND title = ?")
    .get(asset.category, asset.title);
  if (existing) {
    const existingTags = String(existing.tags || "").split(",").filter(Boolean);
    if (!existingTags.includes(ownerTag(packName))) {
      throw new Error(`knowledge asset "${asset.category}/${asset.title}" already exists outside capability pack "${packName}"`);
    }
    db.prepare("UPDATE knowledge SET content = ?, tags = ?, enabled = 1, version_added = ?, updated_at = ? WHERE id = ?")
      .run(content, tagString(packName, asset.tags), packVersion, now, existing.id);
    refreshKnowledgeFts();
    return { id: existing.id, replaced: true, bytes: Buffer.byteLength(content) };
  }
  const result = db
    .prepare("INSERT INTO knowledge (category, title, content, tags, enabled, version_added, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(asset.category, asset.title, content, tagString(packName, asset.tags), packVersion, now);
  refreshKnowledgeFts();
  return { id: result.lastInsertRowid, replaced: false, bytes: Buffer.byteLength(content) };
}

/** Enable/disable a pack's knowledge rows without deleting their content. */
function setAssetEnabled(id, enabled) {
  const db = dbStore.getDb();
  const result = db
    .prepare("UPDATE knowledge SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  if (result.changes > 0) refreshKnowledgeFts();
  return result.changes > 0;
}

function removeAsset(id) {
  const result = dbStore.getDb().prepare("DELETE FROM knowledge WHERE id = ?").run(id);
  if (result.changes > 0) refreshKnowledgeFts();
  return result.changes > 0;
}

function getAsset(id) {
  return dbStore.getDb().prepare("SELECT id, category, title, tags, enabled, version_added, updated_at FROM knowledge WHERE id = ?").get(id) || null;
}

module.exports = { ownerTag, installAsset, setAssetEnabled, removeAsset, getAsset };
