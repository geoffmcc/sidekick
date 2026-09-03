"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (error, code = "invalid_input") => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, error, code }, null, 2) }], isError: true });
async function analyze(services, args) {
  const summary = await services.dispatch("dev_change_summary", { path: args.path, base: args.base, staged: args.staged, max_diff_chars: args.max_diff_chars });
  const maxFiles = Math.max(1, Math.min(2000, Number(services.config?.max_files) || 500));
  const semantic = await services.dispatch("semantic_repo", { path: args.path, action: "query", query: args.query || "changed callers callees dependencies", level: 2, limit: Math.min(args.limit || 40, maxFiles), max_chars: args.max_chars || 12000 });
  const ok = !summary?.isError && !semantic?.isError;
  return { ...result({ ok, status: ok ? "succeeded" : "unavailable", tool: "change_impact", read_only: true, bounded: { max_files: maxFiles }, evidence: { change_summary: summary, semantic_index: semantic }, limitations: ["Blast radius is repository-derived; runtime topology and unreferenced consumers require separate evidence."], deterministic: true }), isError: !ok };
}
async function gate(services, args) {
  const packet = await analyze(services, args);
  const parsed = JSON.parse(packet.content[0].text);
  const findings = parsed.evidence?.change_summary?.findings || parsed.evidence?.change_summary?.risks || [];
  const threshold = args.max_findings || 10;
  return result({ ...parsed, tool: "change_impact_gate", gate: { passed: parsed.ok && findings.length <= threshold, threshold, observed_findings: Array.isArray(findings) ? findings.length : null, basis: "deterministic change-summary findings only" }, policy: { mutation: "none", deployment: "not authorized", runtime_effects: "not inferred" } });
}
  const schema = z.object({ path: z.string().min(1).max(2048), base: z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/).optional(), staged: z.boolean().optional(), query: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional(), max_chars: z.number().int().min(1000).max(60000).optional(), max_diff_chars: z.number().int().min(1000).max(400000).optional(), max_findings: z.number().int().min(0).max(100).optional() }).strict();
  const entry = { buildDescriptors(services) { return [
    { name: "change_impact", aliases: ["blast_radius"], description: "Read-only change impact and blast-radius analysis composed from dev_change_summary and semantic_repo. Results are repository-derived evidence, not runtime predictions.", schema, args: { path: "string", base: "string", staged: "boolean", query: "string", limit: "number", max_chars: "number", max_diff_chars: "number" }, risk: "low", category: "Development", handler: async args => { try { return await analyze(services, args); } catch (error) { return failure(error.message || String(error), "dispatch_failed"); } } },
    { name: "change_impact_gate", description: "Apply a deterministic, read-only finding-count gate to repository change-impact evidence.", schema, args: { path: "string", base: "string", max_findings: "number" }, risk: "low", category: "Development", annotations: { readOnlyHint: true, idempotentHint: true }, handler: async args => { try { return await gate(services, args); } catch (error) { return failure(error.message || String(error), "dispatch_failed"); } } },
  ]; }, healthCheck() { return { ok: true, details: { mode: "read_only", composed: ["dev_change_summary", "semantic_repo"] } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
