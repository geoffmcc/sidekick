"use strict";

const { z } = require("zod");

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function actor(runtime) {
  return runtime?.context?.authIdentity?.principal_id || runtime?.context?.source || "mcp";
}

async function sidekick_network_scopes(args = {}, runtime = {}) {
  const scopes = require("../../security/network-scopes");
  const action = args.action || "list";
  if (["create", "update", "state"].includes(action) && !runtime?.context?.authIdentity?.principal_id) {
    return { content: [{ type: "text", text: "Authentication required for network scope mutations" }], isError: true };
  }
  if (action === "list") return result({ ok: true, action, scopes: scopes.list({ state: args.state, limit: args.limit }) });
  if (action === "get") {
    const scope = scopes.get(args.scope_id || args.name, args.revision);
    return result({ ok: Boolean(scope), action, scope, references: scope ? scopes.references(scope.scope_id) : [] });
  }
  if (action === "validate") return result({ ok: true, action, scope: scopes.validate(args.policy || {}) });
  if (action === "create") return result({ ok: true, action, scope: scopes.create(args.policy || {}, actor(runtime)) });
  if (action === "update") return result({ ok: true, action, scope: scopes.update(args.scope_id || args.name, args.policy || {}, actor(runtime)) });
  if (action === "state") return result({ ok: true, action, scope: scopes.setState(args.scope_id || args.name, args.state, actor(runtime)) });
  if (action === "diagnose") {
    const scope = scopes.get(args.scope_id || args.name, args.revision);
    if (!scope) return result({ ok: false, action, error: "network scope not found" });
    return result({ ok: true, action, scope_id: scope.scope_id, revision: scope.revision, digest: scope.digest, decision: require("../../security/network-scope").decision(scope, args) });
  }
  return { content: [{ type: "text", text: `Unknown network scope action: ${action}` }], isError: true };
}

const descriptors = Object.freeze([Object.freeze({
  name: "network_scopes",
  aliases: ["network_scope"],
  description: "Create, inspect, validate, update, disable, and diagnose named outbound network scopes. Mutations require an authenticated operator and normal critical-tool approval.",
  schema: z.object({
    action: z.enum(["list", "get", "validate", "create", "update", "state", "diagnose"]).optional().default("list"),
    name: z.string().max(80).optional(),
    scope_id: z.string().max(100).optional(),
    revision: z.number().int().positive().optional(),
    state: z.enum(["active", "disabled", "deleted"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    policy: z.record(z.any()).optional().describe("Named scope policy for validate/create/update"),
    host: z.string().optional(),
    address: z.string().optional(),
    protocol: z.string().optional(),
    port: z.number().int().positive().optional(),
  }),
  args: { action: "string (list|get|validate|create|update|state|diagnose)", name: "string", scope_id: "string", revision: "number", state: "string (active|disabled|deleted)", limit: "number", policy: "object", host: "string", address: "string", protocol: "string", port: "number" },
  risk: "critical",
  category: "Networking",
  source: "builtin",
  family: "network-scopes",
  handler: sidekick_network_scopes,
})]);

module.exports = { descriptors, sidekick_network_scopes };
