"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const identifier = value => typeof value === "string" && IDENTIFIER.test(value);
async function read(services, tool, args) { try { return await services.dispatch(tool, args); } catch (error) { return { state: "unavailable", code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300) }; } }

function buildDescriptors(services) {
  return [
    {
      name: "storage_capacity_audit", description: "Collect host disk and configured Proxmox storage capacity evidence without mutation.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional(), node: z.string().regex(IDENTIFIER).or(z.literal("")).optional() }).strict(), args: { profile: "string", node: "string" }, risk: "low", category: "Storage",
      handler: async args => ({ content: [{ type: "text", text: JSON.stringify({ host: await read(services, "status", { include: "disk" }), proxmox: await read(services, "proxmox", { action: "storage_capacity", profile: args.profile, node: args.node }) }, null, 2) }] }),
    },
    {
      name: "storage_backend_audit", description: "Inspect provider-reported storage backends and backup capability; unavailable capacity remains unknown.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional() }).strict(), args: { profile: "string" }, risk: "low", category: "Storage",
      handler: args => (args.profile && !identifier(args.profile)) ? { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "invalid_input", error: "profile must be an identifier" }) }], isError: true, code: "invalid_input" } : services.dispatch("proxmox", { action: "storage_backend_audit", profile: args.profile || undefined }),
    },
    {
      name: "storage_volume_inventory", description: "List configured container volumes through the bounded container provider.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional() }).strict(), args: { profile: "string" }, risk: "low", category: "Storage",
      handler: args => (args.profile && !identifier(args.profile)) ? { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "invalid_input", error: "profile must be an identifier" }) }], isError: true, code: "invalid_input" } : services.dispatch("containers", { action: "volumes", profile: args.profile || undefined }),
    },
  ];
}
function healthCheck({ config }) { const node = config && config.default_node; const valid = node === undefined || node === "" || identifier(node); return { ok: valid, details: { default_node: node || null, invalid_configuration: valid ? null : "default_node must be an identifier", mutation_support: "none", capacity_source: "status and provider storage tools" } }; }
module.exports = { buildDescriptors, healthCheck };
