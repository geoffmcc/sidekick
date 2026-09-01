"use strict";

const MAX_RECIPES = 32;
function clean(value, max = 300) { return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }
function compileVerification(taskSpec, { descriptors = [], mutations = [] } = {}) {
  const criteria = Array.isArray(taskSpec?.success_criteria) ? taskSpec.success_criteria : [];
  const required = Array.isArray(taskSpec?.verification_requirements) ? taskSpec.verification_requirements : [];
  const refs = [...new Set([...criteria, ...required].map(clean).filter(Boolean))].slice(0, MAX_RECIPES);
  const readOnly = (descriptors || []).filter(descriptor => descriptor && descriptor.annotations?.readOnlyHint === true).slice(0, MAX_RECIPES);
  return { version: 3, gates: refs.map((text, index) => ({ recipe_id: `recipe:${clean(taskSpec.task_id, 60)}:${index + 1}`, requirement_id: `requirement:${clean(taskSpec.task_id, 60)}:${index + 1}`, description: text, evidence_standard: taskSpec.requires_live_evidence ? "fresh_authoritative" : "bounded_support" })), mutation_count: Math.min(64, mutations.length), available_read_only_capabilities: readOnly.map(item => clean(item.name, 120)) };
}
module.exports = { MAX_RECIPES, compileVerification };
