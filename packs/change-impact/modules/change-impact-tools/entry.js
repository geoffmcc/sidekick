"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (error, code = "invalid_input") => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, error, code }, null, 2) }], isError: true });
async function analyze(services, args) {
  const summary = await services.dispatch("dev_change_summary", { path: args.path, base: args.base, staged: args.staged, max_diff_chars: args.max_diff_chars });
  const semantic = await services.dispatch("semantic_repo", { path: args.path, action: "query", query: args.query || "changed callers callees dependencies", level: 2, limit: args.limit || 40, max_chars: args.max_chars || 12000 });
  const ok = !summary?.isError && !semantic?.isError;
  return { ...result({ ok, tool: "change_impact", read_only: true, evidence: { change_summary: summary, semantic_index: semantic }, limitations: ["Blast radius is repository-derived; runtime topology and unreferenced consumers require separate evidence."], deterministic: true }), isError: !ok };
}
 const entry = { buildDescriptors(services) { return [{ name: "change_impact", aliases: ["blast_radius"], description: "Read-only change impact and blast-radius analysis composed from dev_change_summary and semantic_repo. Results are repository-derived evidence, not runtime predictions.", schema: z.object({ path: z.string().min(1).max(2048), base: z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/).optional(), staged: z.boolean().optional(), query: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional(), max_chars: z.number().int().min(1000).max(60000).optional(), max_diff_chars: z.number().int().min(1000).max(400000).optional() }).strict(), args: { path: "string", base: "string", staged: "boolean", query: "string", limit: "number", max_chars: "number", max_diff_chars: "number" }, risk: "low", category: "Development", handler: async args => { try { return await analyze(services, args); } catch (error) { return failure(error.message || String(error), "dispatch_failed"); } } }]; }, healthCheck() { return { ok: true, details: { mode: "read_only", composed: ["dev_change_summary", "semantic_repo"] } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
