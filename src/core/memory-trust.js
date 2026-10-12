"use strict";

const AGENT_FACT_SOURCES = new Set(["handoff", "task_session"]);

function requiresMemoryConfirmation(memory) {
  if (!memory || memory.state === "confirmed") return false;
  if (memory.state === "pending" || memory.requires_confirmation === true) return true;
  // Legacy extracted facts predate explicit confirmation marking. Keep them
  // out of automatic context until explicitly confirmed through the memory API.
  return memory.type === "fact" && AGENT_FACT_SOURCES.has(String(memory.source || ""));
}

module.exports = { requiresMemoryConfirmation };
