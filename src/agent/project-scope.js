"use strict";

/** Resolve project scope once at an authenticated task boundary. */
function resolveTaskProjectScope({ requestedProject = null, goal, principalId = null, inferProjectFromText = () => null } = {}) {
  if (requestedProject) return requestedProject;
  // Caller-controlled text may select project scope only at authenticated
  // intake, where current project access is checked before task creation.
  if (!principalId || typeof inferProjectFromText !== "function") return null;
  return inferProjectFromText(goal) || null;
}

/** Durable tasks take scope only from their task record, never recovered text. */
function taskProjectForExecution(task, { goal, parentProject = null, principalId = null, inferProjectFromText = () => null } = {}) {
  if (task && typeof task === "object") return task.project_id || null;
  // If an authenticated task record cannot be found, retain only the scope
  // attached to the authenticated execution context; do not re-parse its text.
  if (principalId) return parentProject || null;
  return (typeof inferProjectFromText === "function" ? inferProjectFromText(goal) : null) || parentProject || null;
}

module.exports = { resolveTaskProjectScope, taskProjectForExecution };
