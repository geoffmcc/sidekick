"use strict";

// =============================================================================
// EXPERIMENTAL FUTURE WORK — NOT A SUPPORTED CAPABILITY. DO NOT ADD PRODUCTION
// CALLERS.
//
// This in-memory identity/teams/memberships/deployment-profile registry is a
// contract sketch (PR #235): plain Maps, no durable tables, no integration
// with authentication, authorization, or the platform kernel, and
// `authorize()` ignores project_id entirely. Sidekick runs in single-operator
// mode; real multi-user identity is Track C work that will land with durable
// tables and a capability bridge — it will not grow out of this file.
//
// Mirrors the platform_model_registry deprecation pattern: kept so its test
// stays buildable, deliberately unbridged, and guarded —
// test/deprecated-kernel-surfaces.test.js fails if production code imports
// this module.
// =============================================================================

const ROLES = new Set(["owner", "admin", "operator", "auditor"]);
const PROFILE_STATES = new Set(["draft", "active", "retired"]);
const PROFILE_ENVIRONMENTS = new Set(["development", "staging", "production"]);

function required(value, name) { const text = String(value || "").trim(); if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(text)) throw new Error(`${name} must be a bounded identifier`); return text; }
function label(value, name) { const text = String(value || "").trim(); if (!/^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,119}$/.test(text)) throw new Error(`${name} must be a bounded label`); return text; }
function createIdentityDeploymentRegistry() {
  const users = new Map(), teams = new Map(), memberships = new Map(), profiles = new Map();
  function addUser(input = {}) { const userId = required(input.user_id, "user_id"); if (users.has(userId)) throw new Error("user already exists"); const user = Object.freeze({ user_id: userId, display_name: label(input.display_name, "display_name"), state: "active" }); users.set(userId, user); return user; }
  function addTeam(input = {}) { const teamId = required(input.team_id, "team_id"); if (teams.has(teamId)) throw new Error("team already exists"); const team = Object.freeze({ team_id: teamId, name: label(input.name, "name"), project_id: input.project_id ? required(input.project_id, "project_id") : null }); teams.set(teamId, team); return team; }
  function addMembership(input = {}) { const userId = required(input.user_id, "user_id"), teamId = required(input.team_id, "team_id"), role = required(input.role, "role"); if (!users.has(userId) || !teams.has(teamId)) throw new Error("membership references unknown identity"); if (!ROLES.has(role)) throw new Error("membership role is not allowed"); const key = `${userId}:${teamId}`; if (memberships.has(key)) throw new Error("membership already exists"); const membership = Object.freeze({ user_id: userId, team_id: teamId, role }); memberships.set(key, membership); return membership; }
  function createDeploymentProfile(input = {}) { const profileId = required(input.profile_id, "profile_id"), state = input.state || "draft", environment = required(input.environment, "environment"); if (profiles.has(profileId)) throw new Error("deployment profile already exists"); if (!PROFILE_STATES.has(state) || !PROFILE_ENVIRONMENTS.has(environment)) throw new Error("deployment profile state or environment is not allowed"); const profile = Object.freeze({ profile_id: profileId, name: label(input.name, "name"), environment, state, project_id: input.project_id ? required(input.project_id, "project_id") : null, required_checks: Array.isArray(input.required_checks) ? [...new Set(input.required_checks.map(check => required(check, "required_check")))] : [] }); profiles.set(profileId, profile); return profile; }
  function authorize(userId, teamId, requiredRole) { const membership = memberships.get(`${required(userId, "user_id")}:${required(teamId, "team_id")}`); if (!membership || !ROLES.has(requiredRole)) return { ok: false, reason: "membership_or_role_missing" }; const order = ["auditor", "operator", "admin", "owner"]; return { ok: order.indexOf(membership.role) >= order.indexOf(requiredRole), reason: order.indexOf(membership.role) >= order.indexOf(requiredRole) ? "allowed" : "role_insufficient", role: membership.role }; }
  return Object.freeze({ addUser, addTeam, addMembership, createDeploymentProfile, authorize });
}
module.exports = Object.freeze({ createIdentityDeploymentRegistry, ROLES, PROFILE_STATES, PROFILE_ENVIRONMENTS });
