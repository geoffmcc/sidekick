"use strict";

const AGENT_GENERATED_SOURCES = new Set(["agent", "handoff", "task_session"]);

function requiresMemoryConfirmation(memory) {
  if (!memory || memory.state === "confirmed") return false;
  if (memory.state === "pending" || memory.requires_confirmation === true) return true;
  // Agent-authored, handoff, and task-session content is persisted model
  // context, not an authenticated instruction source. Older records may lack
  // explicit confirmation flags, and every type must remain out of automatic
  // context until a principal confirms it through the governed memory API.
  return AGENT_GENERATED_SOURCES.has(String(memory.source || ""));
}

module.exports = { requiresMemoryConfirmation };
