"use strict";

const toolContext = require("../context");
const { canonicalizeProjectName } = require("../../core/project-identity");

function contextProject() {
  const project = toolContext.getExecutionContext().project;
  return project ? canonicalizeProjectName(project) : null;
}

function authenticatedPrincipal() {
  return toolContext.getExecutionContext().authIdentity?.principal_id || null;
}

function scopedProject(requested) {
  const bound = contextProject();
  const asked = requested ? canonicalizeProjectName(requested) : null;
  if (bound && asked && bound !== asked) throw new Error("memory project scope denied");
  if (authenticatedPrincipal() && !bound && !asked && toolContext.getExecutionContext().source !== "dashboard") throw new Error("authenticated memory access requires a project scope");
  return bound || asked || null;
}

function inScope(memory) {
  const bound = contextProject();
  if (authenticatedPrincipal() && !bound && toolContext.getExecutionContext().source !== "dashboard") return false;
  if (!bound) return true;
  return Boolean(memory && memory.project && canonicalizeProjectName(memory.project) === bound);
}

function assertInScope(memory) {
  if (!inScope(memory)) throw new Error("memory project scope denied");
  return memory;
}

module.exports = { contextProject, scopedProject, inScope, assertInScope };
