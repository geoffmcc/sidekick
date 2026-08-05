"use strict";

const { z } = require("zod");
const dbStore = require("../../db");

const DEFAULT_CONTEXT = { projects: {}, decisions: [], problems: [], patterns: [], sessions: [], memories: [] };
const CONTEXT_COLLECTIONS = [
  { type: "decision", filter: "decisions", key: "decisions" },
  { type: "problem", filter: "problems", key: "problems" },
  { type: "pattern", filter: "patterns", key: "patterns" },
  { type: "session", filter: "sessions", key: "sessions" },
  { type: "memory", filter: "memories", key: "memories" },
];

function loadContext() {
  return dbStore.loadDocument("context", DEFAULT_CONTEXT);
}

function saveContext(ctx) {
  dbStore.setDocument("context", ctx);
}

function findContextItemById(ctx, id) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  for (const entry of CONTEXT_COLLECTIONS) {
    const list = Array.isArray(ctx[entry.key]) ? ctx[entry.key] : [];
    const index = list.findIndex(item => item && item.id === wanted);
    if (index >= 0) return { ...entry, item: list[index], index };
  }
  return null;
}

function updateLegacyContextItem(id, action, reason) {
  const ctx = loadContext();
  const found = findContextItemById(ctx, id);
  if (!found) return { found: false };

  const now = new Date().toISOString();
  const item = found.item;
  if (action === "delete") {
    item.enabled = false;
    item.state = "deleted";
    item.deleted_at = now;
    item.delete_reason = reason || "user_deleted";
  } else if (action === "disable") {
    item.enabled = false;
    item.state = "disabled";
    item.disabled_at = now;
    item.disable_reason = reason || "user_disabled";
  } else if (action === "expire") {
    item.enabled = false;
    item.state = "expired";
    item.expired_at = now;
    item.expire_reason = reason || "manual_expire";
  } else if (action === "restore") {
    item.enabled = true;
    item.state = "active";
    item.restored_at = now;
    delete item.deleted_at;
    delete item.disabled_at;
    delete item.expired_at;
  } else {
    return { found: true, supported: false, type: found.type };
  }

  item.updated_at = now;
  saveContext(ctx);
  return { found: true, supported: true, type: found.type, id };
}

async function sidekick_memory_manage({ action, id, confirmed_by, days, reason, limit, project }) {
  if (action === "confirm") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id);
    if (legacy) return { content: [{ type: "text", text: `Unsupported memory id for confirm: ${id} is a legacy context ${legacy.type}. Use delete, disable, expire, or restore for legacy context entries.` }], isError: true };
    const success = dbStore.confirmMemory(id, confirmed_by || "user");
    return { content: [{ type: "text", text: success ? `Memory ${id} confirmed` : `Memory not found: ${id}` }], isError: !success };
  }

  if (action === "set_requires_confirmation") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id);
    if (legacy) return { content: [{ type: "text", text: `Unsupported memory id for set_requires_confirmation: ${id} is a legacy context ${legacy.type}. Structured memories only support confirmation requirements.` }], isError: true };
    const requires = reason !== "false";
    const success = dbStore.setMemoryRequiresConfirmation(id, requires);
    return { content: [{ type: "text", text: success ? `Memory ${id} requires_confirmation set to ${requires}` : `Memory not found: ${id}` }], isError: !success };
  }

  if (["delete", "disable", "expire", "restore"].includes(action)) {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const method = { delete: "softDeleteMemory", disable: "disableMemory", expire: "expireMemory", restore: "restoreMemory" }[action];
    const success = action === "delete" ? dbStore[method](id, reason || "user_deleted") : action === "disable" ? dbStore[method](id) : action === "expire" ? dbStore[method](id, reason || "manual_expire") : dbStore[method](id);
    if (success) return { content: [{ type: "text", text: `Memory ${id} ${action === "delete" ? "soft-deleted" : action + "d"}` }] };
    const legacy = updateLegacyContextItem(id, action, reason);
    if (legacy.supported) return { content: [{ type: "text", text: `Legacy context ${legacy.type} ${id} ${action === "delete" ? "soft-deleted" : action + "d"}` }] };
    return { content: [{ type: "text", text: `Memory or context id not found: ${id}` }], isError: true };
  }

  if (action === "set_auto_expire") {
    if (!id || !days) return { content: [{ type: "text", text: "id and days required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id);
    if (legacy) return { content: [{ type: "text", text: `Unsupported memory id for set_auto_expire: ${id} is a legacy context ${legacy.type}. Structured memories only support auto-expiration.` }], isError: true };
    const success = dbStore.setAutoExpire(id, days);
    return { content: [{ type: "text", text: success ? `Memory ${id} will expire in ${days} days` : `Memory not found: ${id}` }], isError: !success };
  }

  if (action === "list_by_state") {
    if (!id) return { content: [{ type: "text", text: "state required (passed as id param)" }], isError: true };
    const memories = dbStore.getMemoriesByState(id, { limit: limit || 50, project });
    return { content: [{ type: "text", text: JSON.stringify({ count: memories.length, memories }, null, 2) }] };
  }
  if (action === "pending_confirmations") {
    const memories = dbStore.getPendingConfirmations({ limit: limit || 50 });
    return { content: [{ type: "text", text: JSON.stringify({ count: memories.length, memories }, null, 2) }] };
  }
  if (action === "process_auto_expirations") {
    const result = dbStore.processAutoExpirations();
    return { content: [{ type: "text", text: `Processed auto-expirations: ${result.expired} memories expired` }] };
  }

  return { content: [{ type: "text", text: "Invalid action. Use: confirm, set_requires_confirmation, delete, disable, expire, restore, set_auto_expire, list_by_state, pending_confirmations, process_auto_expirations" }], isError: true };
}

const descriptors = Object.freeze([Object.freeze({
  name: "memory_manage",
  description: "Manage memory lifecycle: confirm, delete, disable, expire, restore, set auto-expire, list by state, pending confirmations, process auto-expirations",
  schema: z.object({
    action: z.enum(["confirm", "set_requires_confirmation", "delete", "disable", "expire", "restore", "set_auto_expire", "list_by_state", "pending_confirmations", "process_auto_expirations"]).describe("Action to perform"),
    id: z.string().optional().describe("Memory ID (or state name for list_by_state)"),
    confirmed_by: z.string().optional().describe("Who confirmed (for confirm action - default 'user')"),
    days: z.number().optional().describe("Days until expiration (for set_auto_expire)"),
    reason: z.string().optional().describe("Reason for delete/expire"),
    limit: z.number().optional().describe("Limit for list operations (default 50)"),
    project: z.string().optional().describe("Filter by project for list operations"),
  }),
  args: { action: "string (confirm|set_requires_confirmation|delete|disable|expire|restore|set_auto_expire|list_by_state|pending_confirmations|process_auto_expirations)", id: "string (memory/context ID, or state name for list_by_state)", confirmed_by: "string (optional, who confirmed - default 'user')", days: "number (for set_auto_expire)", reason: "string (optional, reason for delete/disable/expire)", limit: "number (optional, for list operations - default 50)", project: "string (optional, filter by project for list operations)" },
  risk: "medium",
  category: "Context & Learning",
  source: "builtin",
  family: "memory-lifecycle",
  handler: sidekick_memory_manage,
})]);

module.exports = { descriptors, sidekick_memory_manage };
