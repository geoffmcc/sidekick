"use strict";

const toolContext = require("../context");
const { canonicalizeProjectName } = require("../../core/project-identity");

function contextProject() {
  const project = toolContext.getExecutionContext().project;
  return project ? canonicalizeProjectName(project) : null;
}

function scopedProject(requested) {
  const bound = contextProject();
  const asked = requested ? canonicalizeProjectName(requested) : null;
  if (bound && asked && bound !== asked) throw new Error("memory project scope denied");
  return bound || asked || null;
}

function inScope(memory) {
  const bound = contextProject();
  if (!bound) return true;
  return Boolean(memory && memory.project && canonicalizeProjectName(memory.project) === bound);
}

function assertInScope(memory) {
  if (!inScope(memory)) throw new Error("memory project scope denied");
  return memory;
}

module.exports = { contextProject, scopedProject, inScope, assertInScope };
