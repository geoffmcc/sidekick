"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const { loadContext, findContextItemById, updateLegacyContextItem } = require("./context");
const { scopedProject, assertInScope } = require("./memory-scope");

async function sidekick_memory_manage({ action, id, confirmed_by, days, reason, limit, project }) {
  let effectiveProject;
  try { effectiveProject = scopedProject(project); } catch (error) { return { content: [{ type: "text", text: error.message }], isError: true }; }
  if (!["list_by_state", "pending_confirmations", "process_auto_expirations"].includes(action) && id) {
    const memory = dbStore.getMemoryById(id, { includeDisabled: true });
    try { assertInScope(memory); } catch { return { content: [{ type: "text", text: "Memory not found: " + id }], isError: true }; }
  }
  if (action === "confirm") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id, "all");
    if (legacy) return { content: [{ type: "text", text: `Unsupported memory id for confirm: ${id} is a legacy context ${legacy.type}. Use delete, disable, expire, or restore for legacy context entries.` }], isError: true };
    const success = dbStore.confirmMemory(id, confirmed_by || "user");
    return { content: [{ type: "text", text: success ? `Memory ${id} confirmed` : `Memory not found: ${id}` }], isError: !success };
  }

  if (action === "set_requires_confirmation") {
    if (!id) return { content: [{ type: "text", text: "id required" }], isError: true };
    const legacy = findContextItemById(loadContext(), id, "all");
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
    const legacy = findContextItemById(loadContext(), id, "all");
    if (legacy) return { content: [{ type: "text", text: `Unsupported memory id for set_auto_expire: ${id} is a legacy context ${legacy.type}. Structured memories only support auto-expiration.` }], isError: true };
    const success = dbStore.setAutoExpire(id, days);
    return { content: [{ type: "text", text: success ? `Memory ${id} will expire in ${days} days` : `Memory not found: ${id}` }], isError: !success };
  }

  if (action === "list_by_state") {
    if (!id) return { content: [{ type: "text", text: "state required (passed as id param)" }], isError: true };
    const memories = dbStore.getMemoriesByState(id, { limit: limit || 50, project: effectiveProject });
    return { content: [{ type: "text", text: JSON.stringify({ count: memories.length, memories }, null, 2) }] };
  }
  if (action === "pending_confirmations") {
    const memories = dbStore.getPendingConfirmations({ limit: limit || 50, project: effectiveProject });
    return { content: [{ type: "text", text: JSON.stringify({ count: memories.length, memories }, null, 2) }] };
  }
  if (action === "process_auto_expirations") {
    const result = dbStore.processAutoExpirations({ project: effectiveProject });
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
