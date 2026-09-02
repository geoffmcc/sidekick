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
async function snapshot(services, args) {
  const calls = [
    ["context", { action: "assemble", project: args.project, query: args.query || args.project, limit: args.limit || 10 }],
    ["memory", { action: "query", project: args.project, query: args.query || "assumption unknown decision blocker", limit: args.limit || 10 }],
    ["handoff", { action: "list", project: args.project, limit: args.limit || 10 }],
  ];
  const evidence = {};
  const failures = [];
  for (const [name, payload] of calls) {
    try { evidence[name] = await services.dispatch(name, payload); if (evidence[name]?.isError) failures.push(name); }
    catch (error) { failures.push(name); evidence[name] = { ok: false, code: error.code || "dependency_failed", error: String(error.message || error).slice(0, 300) }; }
  }
  const supplied = [...(args.assumptions || []).map(value => ({ kind: "assumption", value })), ...(args.unknowns || []).map(value => ({ kind: "unknown", value }))];
  return out({ ok: failures.length === 0, tool: "assumptions_snapshot", read_only: true, project: args.project, evidence, supplied_items: supplied.map(item => ({ ...item, status: "requires_validation" })), source_status: Object.fromEntries(calls.map(([name]) => [name, failures.includes(name) ? "unavailable" : "available"])), evidence_gaps: supplied.length ? ["Caller-supplied items are not claims of fact; validate each against the returned canonical evidence."] : ["No caller-supplied assumptions or unknowns were provided."], provenance: { stores: ["context", "memory", "handoff"], persisted: false } });
}
  const schema = z.object({ project: z.string().regex(/^[a-z0-9_]{1,100}$/), query: z.string().max(500).optional(), assumptions: z.array(z.string().min(1).max(500)).max(50).optional(), unknowns: z.array(z.string().min(1).max(500)).max(50).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
  const entry = { buildDescriptors(services) { return [
    { name: "assumptions", aliases: ["assumptions_unknowns"], description: "Read canonical context, memory and handoff stores to expose assumptions and unknowns. Never writes or creates a competing memory store.", schema, args: { project: "string", query: "string", assumptions: "array of strings", unknowns: "array of strings", limit: "number" }, risk: "low", category: "Reasoning", handler: async args => { try { return await inspect(services, args); } catch (error) { return out({ ok: false, error: error.message || String(error), code: "context_read_failed" }); } } },
    { name: "assumptions_snapshot", description: "Collect canonical continuity evidence and label supplied assumptions and unknowns as requiring validation; this operation never persists them.", schema, args: { project: "string", query: "string", assumptions: "array of strings", unknowns: "array of strings", limit: "number" }, risk: "low", category: "Reasoning", annotations: { readOnlyHint: true, idempotentHint: true }, handler: args => snapshot(services, args) },
  ]; }, healthCheck() { return { ok: true, details: { read_only: true, persistence: "canonical context/memory/handoff", competing_store: false } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
