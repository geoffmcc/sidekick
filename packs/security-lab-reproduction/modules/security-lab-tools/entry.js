"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const net = require("net");
const PUBLIC = /^(?:https?:\/\/)?(?:www\.)?(?:example\.com|example\.org|example\.net|localhost|127\.0\.0\.1)(?:[/:]|$)|^(?:https?:\/\/)?(?:8\.8\.8\.8|1\.1\.1\.1)(?:[/:]|$)/i;
const body = value => String(value?.content?.[0]?.text || value || "").slice(0, 12000);
function privateIp(value) {
  if (net.isIPv4(value)) {
    const octets = value.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
  }
  return net.isIPv6(value) && (/^(?:fc|fd)/i.test(value) || /^fe80:/i.test(value) || value === "::1");
}
async function preflight(services, args) {
  if (args.isolated !== true) return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "isolation_required", error: "security lab reproduction requires isolation" }) }], isError: true };
  if (PUBLIC.test(args.target) || (args.target_kind === "private_ip" && !privateIp(args.target)) || (args.target_kind === "fixture" && !/^[a-z][a-z0-9_.-]{0,79}$/i.test(args.target))) return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "public_target_denied", error: "Security labs require an explicitly authorized private or fixture target; public discovery is unavailable" }) }], isError: true };
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(args.network_scope)) return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "named_network_scope_required", error: "an exact operator-created named network scope is required" }) }], isError: true };
  const network = await services.dispatch("network_scopes", { action: "get", name: args.network_scope });
  const scope = await services.dispatch("research_scope", { action: "evaluate", snapshot_id: args.snapshot_id, target: { kind: args.target_kind, value: args.target }, operation: args.operation });
  const ok = !network?.isError && !scope?.isError;
  return { content: [{ type: "text", text: JSON.stringify({ ok, tool: "lab_preflight", target: args.target, target_kind: args.target_kind, operation: args.operation, named_network_scope: body(network), authorization_scope: body(scope), evidence: { network_scope: !network?.isError, authorization: !scope?.isError }, execution: "not started", public_discovery: false, arbitrary_commands: false, evidence_capture: "performed only by the research run/evidence authority" }, null, 2) }], isError: !ok };
}
 const entry = { buildDescriptors(services) { return [{ name: "lab_preflight", description: "Validate an explicitly scoped private/fixture reproduction target and exact named network scope without probing or executing it", schema: z.object({ snapshot_id: z.string().min(1).max(200), network_scope: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), target: z.string().min(1).max(500), target_kind: z.enum(["private_ip", "hostname", "fixture"]), operation: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), isolated: z.literal(true) }).strict(), args: { snapshot_id: "string", network_scope: "string", target: "string", target_kind: "string", operation: "string", isolated: "boolean" }, risk: "high", category: "Security", handler: args => preflight(services, args) }]; }, healthCheck({ config }) { return { ok: config.require_isolated !== false, details: { require_isolated: config.require_isolated !== false, public_discovery: false, arbitrary_commands: false, named_network_scope: true } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
