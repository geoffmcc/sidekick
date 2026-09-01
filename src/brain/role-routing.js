"use strict";

const ROLES = Object.freeze(["objective_compiler", "planner", "capability_ranker", "critic", "research_reasoner", "synthesizer", "memory_curator", "verification_reviewer"]);
const MAX_CHAIN = 4;
const ROLE_CAPABILITIES = Object.freeze({ objective_compiler: "chat", planner: "generate", capability_ranker: "chat", critic: "chat", research_reasoner: "chat", synthesizer: "chat", memory_curator: "generate", verification_reviewer: "chat" });
function clean(value, max = 120) { return String(value == null ? "" : value).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, max); }
function routeRole(role, { available = [], configured = {}, fallback = [] } = {}) {
  if (!ROLES.includes(role)) throw new Error("unsupported Brain model role");
  const candidates = [configured[role], ...(Array.isArray(fallback) ? fallback : [])].filter(Boolean).map(value => clean(value));
  const selected = candidates.find(candidate => available.includes(candidate)) || (available[0] ? clean(available[0]) : null);
  return { version: 3, role, selected, candidates: [...new Set(candidates)].slice(0, MAX_CHAIN), degraded: !selected || (candidates.length > 0 && selected !== candidates[0]), reason: selected ? (candidates.length && selected === candidates[0] ? "configured" : "fallback") : "no_eligible_model" };
}
function routeRoles(options = {}) { return Object.fromEntries(ROLES.map(role => [role, routeRole(role, options)])); }
function rolePlacementRequest(role, options = {}) {
  if (!ROLES.includes(role)) throw new Error("unsupported Brain model role");
  const classification = ["public", "internal", "private", "sensitive", "restricted"].includes(options.data_classification) ? options.data_classification : "private";
  const capability = ROLE_CAPABILITIES[role];
  return {
    version: 1,
    capability,
    workload_class: role,
    data_classification: classification,
    requirements: { structured_output: role === "objective_compiler" || role === "planner" || role === "critic" || role === "verification_reviewer" },
    preferences: { allow_fallback: options.allow_fallback !== false },
  };
}
module.exports = { ROLES, MAX_CHAIN, ROLE_CAPABILITIES, routeRole, routeRoles, rolePlacementRequest };
