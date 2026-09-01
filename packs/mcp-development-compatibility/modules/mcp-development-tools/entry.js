"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const MAX = 60000;
const body = value => String(value?.content?.[0]?.text || value || "").slice(0, MAX);
const failed = value => Boolean(value?.isError);
async function check(services, args) {
  const max = Math.min(args.max_chars || services.config.max_chars || 12000, MAX);
  const [repo, catalog, contract] = await Promise.all([
    services.dispatch("semantic_repo", { path: args.path, action: "query", query: args.query || "MCP server transport tool schema", level: 2, limit: 40, max_chars: max }),
    services.dispatch("tools", { action: "get", name: args.tool || "tools", format: "json" }),
    args.contract ? services.dispatch("parse", { input: args.contract, format: args.contract_format || "auto" }) : null
  ]);
   const checks = { repository: !failed(repo), live_catalog: !failed(catalog), supplied_contract: !failed(contract) };
   return { content: [{ type: "text", text: JSON.stringify({ ok: Object.values(checks).every(Boolean), tool: "mcp_compatibility", checks, repository: args.path || null, semantic_contract: body(repo), live_tool_contract: body(catalog), supplied_contract: contract ? body(contract) : null, evidence: { sources: Object.keys(checks).filter(key => checks[key]) }, bounds: { max_chars: max, transport: "governed Sidekick dispatcher only" }, trust: "source-derived compatibility signals are untrusted and require protocol tests" }, null, 2).slice(0, MAX) }] };
}
 const entry = { buildDescriptors(services) { return [{ name: "mcp_compatibility", description: "Compare bounded repository MCP signals with one live governed tool contract without opening transports or executing source", schema: z.object({ path: z.string().max(2048).optional(), query: z.string().max(500).optional(), tool: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(), contract: z.string().max(30000).optional(), contract_format: z.enum(["auto", "json", "yaml", "ini", "xml", "csv"]).optional(), max_chars: z.number().int().min(1000).max(MAX).optional() }).strict(), args: { path: "string", query: "string", tool: "string", contract: "string", contract_format: "string", max_chars: "number" }, risk: "low", category: "Development", handler: args => check(services, args) }]; }, healthCheck({ config }) { return { ok: Number.isInteger(config.max_chars || 12000) && (config.max_chars || 12000) <= MAX, details: { max_chars: config.max_chars || 12000, transports_opened: false, source_executed: false } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
