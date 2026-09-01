"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const out = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const scrub = value => JSON.parse(JSON.stringify(value, (key, current) => { if (/pass(word)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie/i.test(key)) return "[REDACTED]"; if (typeof current === "string" && current.length > 2000) return `${current.slice(0, 2000)}...[TRUNCATED]`; return current; }));
async function bundle(services, args) {
  const profile = await services.dispatch("dev_repo_profile", { path: args.path, max_files: args.max_files || 500, include_git: true, include_semantic: false });
  const semantic = await services.dispatch("semantic_repo", { path: args.path, action: "verify", level: 0 });
  const payload = scrub({ format: "sidekick-reproducibility-v1", generated_at: new Date().toISOString(), repository: profile, semantic, inputs: { path: args.path, label: args.label || null }, bounds: { max_chars: args.max_chars || 30000, secrets: "redacted", raw_source: "not included" } });
  const encoded = JSON.stringify(payload);
  if (encoded.length > (args.max_chars || 30000)) return out({ ok: false, error: "bundle exceeds configured bound; reduce repository scope", code: "bundle_too_large", size: encoded.length, max_chars: args.max_chars || 30000 });
  const evidence = await services.dispatch("research_evidence", { action: "capture", project_id: args.project, type: "reproducibility_bundle", name: args.label || "reproducibility-bundle", data: payload, content_type: "application/json", sensitivity: "internal", redaction_state: "redacted" });
  if (evidence?.isError) return out({ ok: false, code: "evidence_capture_failed", error: "research evidence custody rejected the bundle" });
  return out({ ok: true, tool: "reproducibility", bundle: { evidence, format: payload.format, size: encoded.length, secret_safe: true, bounded: true }, evidence_recorded: true });
}
 const entry = { buildDescriptors(services) { return [{ name: "reproducibility", aliases: ["repro_bundle"], description: "Build a bounded secret-safe reproducibility bundle from repository profile and semantic evidence, then store it through research evidence artifact custody.", schema: z.object({ path: z.string().min(1).max(2048), project: z.string().regex(/^[a-z0-9_]{1,100}$/), label: z.string().max(120).optional(), max_chars: z.number().int().min(1000).max(60000).optional(), max_files: z.number().int().min(1).max(2000).optional() }).strict(), args: { path: "string", project: "string", label: "string", max_chars: "number", max_files: "number" }, risk: "medium", category: "Development", handler: async args => { try { return await bundle(services, args); } catch (error) { return out({ ok: false, error: error.message || String(error), code: "bundle_failed" }); } } }]; }, healthCheck() { return { ok: true, details: { storage: "research_evidence custody", secret_safe: true, bounded: true } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
