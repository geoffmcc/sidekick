"use strict";
const assert = require("assert");
const { createIdentityDeploymentRegistry } = require("../src/platform/identity-deployment");

console.log("Running Identity and Deployment Profile Tests...\n");
const registry = createIdentityDeploymentRegistry();
registry.addUser({ user_id: "user:synthetic", display_name: "Synthetic Operator" });
registry.addTeam({ team_id: "team:synthetic", name: "Synthetic Team", project_id: "project:fixture" });
registry.addMembership({ user_id: "user:synthetic", team_id: "team:synthetic", role: "operator" });
assert.strictEqual(registry.authorize("user:synthetic", "team:synthetic", "auditor").ok, true);
assert.strictEqual(registry.authorize("user:synthetic", "team:synthetic", "admin").ok, false);
const profile = registry.createDeploymentProfile({ profile_id: "profile:fixture", name: "Synthetic Staging", environment: "staging", project_id: "project:fixture", required_checks: ["ci", "ci"] });
assert.deepStrictEqual(profile.required_checks, ["ci"], "deployment checks should be deterministic and unique");
assert.throws(() => registry.addMembership({ user_id: "user:synthetic", team_id: "team:synthetic", role: "root" }), /not allowed/);
assert.throws(() => registry.createDeploymentProfile({ profile_id: "profile:prod", name: "Unsafe", environment: "production", state: "unknown" }), /not allowed/);
console.log("Identity and deployment profile tests passed.");
