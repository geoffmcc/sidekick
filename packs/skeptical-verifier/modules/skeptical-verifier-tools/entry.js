"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const out = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = message => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, code: "verification_failed" }, null, 2) }], isError: true });
async function verify(services, args) {
  const profile = await services.dispatch("dev_repo_profile", { path: args.path, include_git: true, include_semantic: false, max_files: args.max_files || 500 });
  const semantic = await services.dispatch("semantic_repo", { path: args.path, action: "verify", level: 0 });
  const health = await services.dispatch("health", { check: "all" });
  const snapshot = args.snapshot ? await services.dispatch("snapshot", { action: "compare", compare: args.snapshot }) : null;
  const checks = { profile, semantic, health, snapshot };
  const ok = Object.values(checks).filter(Boolean).every(value => !value.isError);
  return { ...out({ ok, tool: "skeptical_verify", verdict: ok ? "evidence_collected" : "evidence_incomplete", independent: true, read_only: true, executed_project_commands: false, checks, evidence: { sources: Object.keys(checks).filter(key => checks[key] && !checks[key].isError) }, interpretation_required: true, limitations: ["This verifier does not run tests, mutate snapshots, or assert production equivalence."] }), isError: !ok };
}
 const entry = { buildDescriptors(services) { return [{ name: "skeptical_verify", aliases: ["independent_verify"], description: "Independent read-only verification using repository profile, semantic index verification, health, and an optional existing snapshot. Never runs project commands or mutates state.", schema: z.object({ path: z.string().min(1).max(2048), snapshot: z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/).optional(), max_files: z.number().int().min(1).max(2000).optional() }).strict(), args: { path: "string", snapshot: "string", max_files: "number" }, risk: "low", category: "Verification", handler: async args => { try { return await verify(services, args); } catch (error) { return fail(error.message || String(error)); } } }]; }, healthCheck() { return { ok: true, details: { mode: "independent_read_only", project_commands: false, state_mutations: false } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
