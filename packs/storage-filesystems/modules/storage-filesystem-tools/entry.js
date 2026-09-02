"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const identifier = value => typeof value === "string" && IDENTIFIER.test(value);
async function read(services, tool, args) { try { return await services.dispatch(tool, args); } catch (error) { return { state: "unavailable", code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300) }; } }
function decode(value) { try { return JSON.parse(value?.content?.map(item => item.text || "").join("") || ""); } catch { return value; } }
function capacity(value) { const data = decode(value); const candidates = [data, data?.disk, data?.storage, data?.data]; for (const item of candidates) if (item && Number.isFinite(Number(item.percent_used))) return Number(item.percent_used); if (data?.total_bytes && Number(data.used_bytes) >= 0) return Number(data.used_bytes) / Number(data.total_bytes) * 100; return null; }

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
    {
      name: "storage_threshold_check", description: "Classify available capacity against warning and critical thresholds without treating an unavailable provider as healthy.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional(), node: z.string().regex(IDENTIFIER).or(z.literal("")).optional(), warn_percent: z.number().min(1).max(99).optional(), critical_percent: z.number().min(1).max(100).optional() }).strict(), args: { profile: "string", node: "string", warn_percent: "number", critical_percent: "number" }, risk: "low", category: "Storage",
      handler: async args => { const warn = args.warn_percent ?? 80; const critical = args.critical_percent ?? 90; if (critical <= warn) return { content: [{ type: "text", text: JSON.stringify({ ok: false, state: "unavailable", code: "invalid_thresholds", error: "critical_percent must be greater than warn_percent" }) }], isError: true }; const source = args.profile || args.node ? await read(services, "proxmox", { action: "storage_capacity", profile: args.profile || undefined, node: args.node || undefined }) : await read(services, "status", { include: "disk" }); const used = capacity(source); const state = used === null ? "unavailable" : used >= critical ? "critical" : used >= warn ? "warning" : "healthy"; return { content: [{ type: "text", text: JSON.stringify({ ok: state === "healthy" || state === "warning", tool: "storage_threshold_check", state, used_percent: used, thresholds: { warn_percent: warn, critical_percent: critical }, source, interpretation_required: state === "unavailable", unavailable_is_not_healthy: true }) }] }; },
    },
  ];
}
function healthCheck({ config }) { const node = config && config.default_node; const valid = node === undefined || node === "" || identifier(node); return { ok: valid, details: { default_node: node || null, invalid_configuration: valid ? null : "default_node must be an identifier", mutation_support: "none", capacity_source: "status and provider storage tools" } }; }
module.exports = { buildDescriptors, healthCheck };
