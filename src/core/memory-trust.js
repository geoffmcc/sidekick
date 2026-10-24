"use strict";

const AGENT_GENERATED_SOURCES = new Set(["handoff", "task_session"]);

function requiresMemoryConfirmation(memory) {
  if (!memory || memory.state === "confirmed") return false;
  if (memory.state === "pending" || memory.requires_confirmation === true) return true;
  // Handoff and task-session content is persisted agent context, not an
  // authenticated instruction source. Older records may lack explicit
  // confirmation flags, and every extracted type (including decisions,
  // procedures, and negatives) must remain out of automatic context until a
  // principal confirms it through the governed memory API.
  return AGENT_GENERATED_SOURCES.has(String(memory.source || ""));
}

module.exports = { requiresMemoryConfirmation };
