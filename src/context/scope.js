"use strict";

const { PROJECT_RE, canonicalizeProjectName } = require("../core/project-identity");

const SOURCE_TYPES = Object.freeze([
  "knowledge", "memory", "legacy_context", "handoff", "session",
  "artifact", "entity", "relationship", "evidence", "repository_semantic",
]);

function normalizeProject(project) {
  if (project == null || project === "") return null;
  const raw = String(project).trim();
  // Explicit scope is an authorization boundary, so do not silently repair
  // path-like, mixed-case, or punctuation-bearing input into another project.
  if (!PROJECT_RE.test(raw)) return null;
  return canonicalizeProjectName(raw);
}

function authorizeScope({ project, principalId = null, allowedProjects = null, requireProject = false } = {}) {
  const normalized = normalizeProject(project);
  if (project != null && !normalized) {
    return { ok: false, code: "invalid_project_scope", project: null, principalId: principalId || null };
  }
  if (requireProject && !normalized) {
    return { ok: false, code: "project_scope_required", project: null, principalId: principalId || null };
  }
  if (allowedProjects != null) {
    if (!Array.isArray(allowedProjects)) return { ok: false, code: "invalid_authorized_projects" };
    const allowed = new Set(allowedProjects.map(normalizeProject).filter(Boolean));
    if (!normalized || !allowed.has(normalized)) {
      return { ok: false, code: "project_scope_forbidden", project: normalized, principalId: principalId || null };
    }
  }
  return {
    ok: true,
    project: normalized,
    principalId: principalId || null,
    authorizedProjects: normalized ? [normalized] : [],
  };
}

function sourceAllowed(source, permittedSources) {
  if (!permittedSources) return true;
  return Array.isArray(permittedSources) && permittedSources.includes(source);
}

module.exports = Object.freeze({ SOURCE_TYPES, normalizeProject, authorizeScope, sourceAllowed });
