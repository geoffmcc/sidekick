"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
async function call(services, name, args) { const value = await services.dispatch(name, args); if (value?.isError) throw Object.assign(new Error(`${name} dependency failed`), { code: value.code || "dependency_failed", dependency: name }); return value; }
function successful(value) { return value && !value.isError && /"ok"\s*:\s*(true|1)/i.test(value.content?.map(item => item.text || "").join("\n") || ""); }
async function gate(services, args) {
  const mode = args.mode || services.config?.default_mode || "standard";
  const verification = await call(services, "dev_verify", { path: args.path, mode, intents: args.intents, continue_on_failure: args.continue_on_failure === true, max_output_chars: args.max_output_chars || services.config?.max_output_chars || 12000, timeout_ms: args.timeout_ms || 600000, dry_run: args.dry_run === true });
  const profile = await call(services, "dev_repo_profile", { path: args.path, include_git: true, include_semantic: false });
  const semantic = await call(services, "semantic_repo", { path: args.path, action: "verify" });
  return result({ ok: successful(verification) && successful(profile) && successful(semantic), verification, repository: profile, semantic_index: semantic, deterministic_gate: "verification result and semantic index integrity are reported separately" });
}
async function health(services) { const checks = {}; for (const [name, args] of [["dev_verify", { path: process.cwd(), dry_run: true, intents: ["syntax"] }], ["dev_repo_profile", { path: process.cwd(), include_git: false, include_semantic: false }], ["semantic_repo", { path: process.cwd(), action: "verify" }]]) { try { await call(services, name, args); checks[name] = true; } catch { checks[name] = false; } } return result({ ok: Object.values(checks).every(Boolean), checks, writes: false }); }
const entry = { buildDescriptors(services) { return [
  { name: "quality_gate", description: "Run or plan bounded project verification and independently verify the semantic repository index.", schema: z.object({ path: z.string().min(1).max(2048), mode: z.enum(["quick", "standard", "full"]).optional(), intents: z.array(z.enum(["syntax", "lint", "typecheck", "test", "build"])).min(1).max(5).optional(), continue_on_failure: z.boolean().optional(), max_output_chars: z.number().int().min(500).max(60000).optional(), timeout_ms: z.number().int().min(1000).max(600000).optional(), dry_run: z.boolean().optional() }).strict(), args: { path: "string", mode: "string", intents: "array", dry_run: "boolean" }, risk: "high", category: "Development", handler: args => gate(services, args) },
  { name: "quality_health", description: "Probe verification, repository profiling and semantic-index dependencies without executing project tests.", schema: z.object({}), args: {}, risk: "low", category: "Development", annotations: { readOnlyHint: true, idempotentHint: true }, handler: () => health(services) },
]; }, healthCheck({ config }) { return { ok: ["quick", "standard", "full"].includes(config?.default_mode || "standard"), details: { default_mode: config?.default_mode || "standard", dependencies: ["dev_verify", "dev_repo_profile", "semantic_repo"], project_execution: "only through dev_verify" } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
