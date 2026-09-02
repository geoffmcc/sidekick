"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const MAX = 60000;
const body = value => String(value?.content?.[0]?.text || value || "").slice(0, MAX);
const failed = value => Boolean(value?.isError);
const bounded = value => { const serialized = JSON.stringify(value, null, 2); return serialized.length <= MAX ? serialized : JSON.stringify({ ok: false, code: "result_too_large", error: "bounded result exceeded output limit", evidence: [] }); };
async function check(services, args) {
  const max = Math.min(args.max_chars || services.config.max_chars || 12000, MAX);
  const [repo, catalog, contract] = await Promise.all([
    services.dispatch("semantic_repo", { path: args.path, action: "query", query: args.query || "MCP server transport tool schema", level: 2, limit: 40, max_chars: max }),
    services.dispatch("tools", { action: "get", name: args.tool || "tools", format: "json" }),
    args.contract ? services.dispatch("parse", { input: args.contract, format: args.contract_format || "auto" }) : null
  ]);
   const checks = { repository: !failed(repo), live_catalog: !failed(catalog), supplied_contract: !failed(contract) };
    return { content: [{ type: "text", text: bounded({ ok: Object.values(checks).every(Boolean), tool: "mcp_compatibility", checks, repository: args.path || null, semantic_contract: body(repo), live_tool_contract: body(catalog), supplied_contract: contract ? body(contract) : null, evidence: { sources: Object.keys(checks).filter(key => checks[key]) }, bounds: { max_chars: max, transport: "governed Sidekick dispatcher only" }, trust: "source-derived compatibility signals are untrusted and require protocol tests" }) }] };
}
async function catalogOperation(services, args) {
  try { const value = await services.dispatch("tools", { action: args.action, name: args.name, query: args.query, category: args.category, limit: args.limit, format: "json" }); return { content: [{ type: "text", text: bounded({ ok: !failed(value), action: args.action, result: body(value), evidence: [{ source: "tools", action: args.action }], trust: "catalog data is untrusted metadata" }) }] }; }
  catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300), evidence: [] }) }] }; }
}
 const entry = { buildDescriptors(services) { return [{ name: "mcp_compatibility", description: "Compare bounded repository MCP signals with one live governed tool contract without opening transports or executing source", schema: z.object({ path: z.string().max(2048).optional(), query: z.string().max(500).optional(), tool: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(), contract: z.string().max(30000).optional(), contract_format: z.enum(["auto", "json", "yaml", "ini", "xml", "csv"]).optional(), max_chars: z.number().int().min(1000).max(MAX).optional() }).strict(), args: { path: "string", query: "string", tool: "string", contract: "string", contract_format: "string", max_chars: "number" }, risk: "low", category: "Development", handler: args => check(services, args) }, { name: "mcp_catalog_operation", description: "Inspect the live governed MCP tool catalog or policy without opening a transport.", schema: z.object({ action: z.enum(["overview", "search", "get", "policy"]), name: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(), query: z.string().max(500).optional(), category: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().superRefine((v, c) => { if (["get", "policy"].includes(v.action) && !v.name) c.addIssue({ code: "custom", message: "name is required for get and policy" }); if (v.action === "search" && !v.query) c.addIssue({ code: "custom", message: "query is required for search" }); }), args: { action: "string", name: "string", query: "string", category: "string", limit: "number" }, risk: "low", category: "Development", annotations: { readOnlyHint: true }, handler: args => catalogOperation(services, args) }]; }, healthCheck({ config }) { return { ok: Number.isInteger(config.max_chars || 12000) && (config.max_chars || 12000) <= MAX, details: { max_chars: config.max_chars || 12000, transports_opened: false, source_executed: false } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
