"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const out = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
async function inspect(services, args) {
  const context = await services.dispatch("context", { action: "assemble", project: args.project, query: args.query || args.project, limit: args.limit || 10 });
  const memory = await services.dispatch("memory", { action: "query", project: args.project, query: args.query || "assumption unknown decision blocker", limit: args.limit || 10 });
  const handoff = await services.dispatch("handoff", { action: "list", project: args.project, limit: args.limit || 10 });
  const sources = { context, memory, handoff };
  const complete = Object.values(sources).every(value => !value?.isError);
  return { ...out({ ok: complete, tool: "assumptions", read_only: true, project: args.project, sources, assumptions: args.assumptions || [], unknowns: args.unknowns || [], evidence: { sources: Object.keys(sources).filter(key => !sources[key]?.isError) }, evidence_gaps: ["Caller-supplied assumptions and unknowns are not persisted by this pack.", "Validate each gap against current repository or runtime evidence before acting."], storage: "canonical context/memory/handoff only; no competing store" }), isError: !complete };
}
 const entry = { buildDescriptors(services) { return [{ name: "assumptions", aliases: ["assumptions_unknowns"], description: "Read canonical context, memory and handoff stores to expose assumptions and unknowns. Never writes or creates a competing memory store.", schema: z.object({ project: z.string().regex(/^[a-z0-9_]{1,100}$/), query: z.string().max(500).optional(), assumptions: z.array(z.string().min(1).max(500)).max(50).optional(), unknowns: z.array(z.string().min(1).max(500)).max(50).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(), args: { project: "string", query: "string", assumptions: "array of strings", unknowns: "array of strings", limit: "number" }, risk: "low", category: "Reasoning", handler: async args => { try { return await inspect(services, args); } catch (error) { return out({ ok: false, error: error.message || String(error), code: "context_read_failed" }); } } }]; }, healthCheck() { return { ok: true, details: { read_only: true, persistence: "canonical context/memory/handoff", competing_store: false } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
