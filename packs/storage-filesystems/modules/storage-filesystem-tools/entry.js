"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const identifier = value => typeof value === "string" && IDENTIFIER.test(value);
async function read(services, tool, args) { try { return await services.dispatch(tool, args); } catch (error) { return { state: "unavailable", code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300) }; } }
function decode(value) { try { return JSON.parse(value?.content?.map(item => item.text || "").join("") || ""); } catch { return value; } }
function finiteNumber(value) { if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function capacity(value) {
  const data = decode(value);
  const candidates = [data, data?.disk, data?.storage, data?.data];
  for (const item of candidates) {
    const percent = finiteNumber(item?.percent_used);
    if (percent !== null && percent >= 0 && percent <= 100) return percent;
  }
  const total = finiteNumber(data?.total_bytes);
  const used = finiteNumber(data?.used_bytes);
  return total !== null && total > 0 && used !== null && used >= 0 ? used / total * 100 : null;
}
function sourceState(value) {
  const data = decode(value);
  if (value?.isError || data?.ok === false || ["unavailable", "error", "failed"].includes(String(data?.state || data?.status || "").toLowerCase())) return "unavailable";
  return "observed";
}

function buildDescriptors(services) {
  return [
    {
      name: "storage_capacity_audit", description: "Collect host disk and configured Proxmox storage capacity evidence without mutation.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional().describe("Exact configured Proxmox profile; omit to use the configured default."), node: z.string().regex(IDENTIFIER).or(z.literal("")).optional().describe("Observed Proxmox node name; use only when requesting node-scoped storage." ) }).strict(), args: { profile: "string (configured Proxmox profile; omit for default)", node: "string (observed Proxmox node name; optional)" }, risk: "low", category: "Storage",
      handler: async args => {
        const host = await read(services, "status", { include: "disk" });
        const proxmox = await read(services, "proxmox", { action: "storage_capacity", profile: args.profile, node: args.node });
        const states = { host: sourceState(host), proxmox: sourceState(proxmox) };
        const unavailable = Object.values(states).filter(state => state === "unavailable").length;
        const state = unavailable === 2 ? "unavailable" : unavailable === 1 ? "partial" : "observed";
        return { content: [{ type: "text", text: JSON.stringify({ ok: state !== "unavailable", state, sources: states, warnings: Object.entries(states).filter(([, value]) => value === "unavailable").map(([source]) => `${source} evidence is unavailable`), host, proxmox, unavailable_is_not_healthy: true }, null, 2) }] };
      },
    },
    {
      name: "storage_backend_audit", description: "Inspect provider-reported storage backends and backup capability; unavailable capacity remains unknown.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional().describe("Exact configured Proxmox profile; omit to use the configured default.") }).strict(), args: { profile: "string (configured Proxmox profile; omit for default)" }, risk: "low", category: "Storage",
      handler: args => (args.profile && !identifier(args.profile)) ? { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "invalid_input", error: "profile must be an identifier" }) }], isError: true, code: "invalid_input" } : services.dispatch("proxmox", { action: "storage_backend_audit", profile: args.profile || undefined }),
    },
    {
      name: "storage_volume_inventory", description: "List configured container volumes through the bounded container provider.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional().describe("Exact configured container profile; omit to use the configured default.") }).strict(), args: { profile: "string (configured container profile; omit for default)" }, risk: "low", category: "Storage",
      handler: args => (args.profile && !identifier(args.profile)) ? { content: [{ type: "text", text: JSON.stringify({ ok: false, code: "invalid_input", error: "profile must be an identifier" }) }], isError: true, code: "invalid_input" } : services.dispatch("containers", { action: "volumes", profile: args.profile || undefined }),
    },
    {
      name: "storage_threshold_check", description: "Classify available capacity against warning and critical thresholds without treating an unavailable provider as healthy.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional().describe("Exact configured Proxmox profile; omit to use host status unless node is set."), node: z.string().regex(IDENTIFIER).or(z.literal("")).optional().describe("Observed Proxmox node name; use only for node-scoped capacity."), warn_percent: z.number().min(1).max(99).optional().describe("Warning threshold from 1 through 99 percent; defaults to 80."), critical_percent: z.number().min(1).max(100).optional().describe("Critical threshold greater than warn_percent and at most 100; defaults to 90.") }).strict(), args: { profile: "string (configured Proxmox profile; omit for host status)", node: "string (observed Proxmox node name; optional)", warn_percent: "number (1-99; default 80)", critical_percent: "number (greater than warning and at most 100; default 90)" }, risk: "low", category: "Storage",
      handler: async args => { const warn = args.warn_percent ?? 80; const critical = args.critical_percent ?? 90; if (critical <= warn) return { content: [{ type: "text", text: JSON.stringify({ ok: false, state: "unavailable", code: "invalid_thresholds", error: "critical_percent must be greater than warn_percent" }) }], isError: true }; const source = args.profile || args.node ? await read(services, "proxmox", { action: "storage_capacity", profile: args.profile || undefined, node: args.node || undefined }) : await read(services, "status", { include: "disk" }); const used = capacity(source); const state = used === null ? "unavailable" : used >= critical ? "critical" : used >= warn ? "warning" : "healthy"; return { content: [{ type: "text", text: JSON.stringify({ ok: state === "healthy" || state === "warning", tool: "storage_threshold_check", state, used_percent: used, thresholds: { warn_percent: warn, critical_percent: critical }, source, interpretation_required: state === "unavailable", unavailable_is_not_healthy: true }) }] }; },
    },
  ];
}
function healthCheck({ config }) { const node = config && config.default_node; const valid = node === undefined || node === "" || identifier(node); return { ok: valid, details: { default_node: node || null, invalid_configuration: valid ? null : "default_node must be an identifier", mutation_support: "none", capacity_source: "status and provider storage tools" } }; }
module.exports = { buildDescriptors, healthCheck };
