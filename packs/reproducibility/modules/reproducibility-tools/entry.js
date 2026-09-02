"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const crypto = require("crypto");
const out = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
function scrub(value, key = "") {
  if (/pass(word)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie/i.test(key)) return "[REDACTED]";
  if (/^(generated_at|created_at|updated_at|timestamp)$/i.test(key)) return undefined;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...[TRUNCATED]` : value;
  if (Array.isArray(value)) return value.map(item => scrub(item)).filter(item => item !== undefined);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((result, child) => { const item = scrub(value[child], child); if (item !== undefined) result[child] = item; return result; }, {});
  return value;
}
function dependency(value, name) { return value?.isError ? { state: "unavailable", source: name, code: value.code || "dependency_failed" } : value; }
async function bundle(services, args) {
  const profile = dependency(await services.dispatch("dev_repo_profile", { path: args.path, max_files: args.max_files || 500, include_git: true, include_semantic: false }), "dev_repo_profile");
  const semantic = dependency(await services.dispatch("semantic_repo", { path: args.path, action: "verify", level: 0 }), "semantic_repo");
  // A bundle is a content address, not a timestamped log. This makes identical
  // repository evidence compare equal across runs.
  const payload = scrub({ format: "sidekick-reproducibility-v1", repository: profile, semantic, inputs: { path: args.path, label: args.label || null }, bounds: { max_chars: args.max_chars || 30000, secrets: "redacted", raw_source: "not included" } });
  const encoded = JSON.stringify(payload);
  if (encoded.length > (args.max_chars || 30000)) return out({ ok: false, error: "bundle exceeds configured bound; reduce repository scope", code: "bundle_too_large", size: encoded.length, max_chars: args.max_chars || 30000 });
  if (profile?.state === "unavailable" || semantic?.state === "unavailable") return out({ ok: false, state: "unavailable", code: "source_unavailable", sources: { profile, semantic } });
  const evidence = await services.dispatch("research_evidence", { action: "capture", project_id: args.project, type: "reproducibility_bundle", name: args.label || "reproducibility-bundle", data: payload, content_type: "application/json", sensitivity: "internal", redaction_state: "redacted", metadata: { deterministic: true, freshness: "capture-time only; source freshness not asserted" } });
  if (evidence?.isError) return { ...out({ ok: false, state: "unavailable", code: "evidence_capture_failed", error: "research evidence custody rejected the bundle" }), isError: true };
  return out({ ok: true, tool: "reproducibility", bundle: { evidence, format: payload.format, size: encoded.length, sha256: crypto.createHash("sha256").update(encoded).digest("hex"), secret_safe: true, bounded: true, deterministic: true }, evidence_recorded: true });
}
  const entry = { buildDescriptors(services) { return [{ name: "reproducibility", aliases: ["repro_bundle"], description: "Build a bounded secret-safe reproducibility bundle from repository profile and semantic evidence, then store it through research evidence artifact custody.", schema: z.object({ path: z.string().min(1).max(2048), project: z.string().regex(/^[a-z0-9_]{1,100}$/), label: z.string().max(120).optional(), max_chars: z.number().int().min(1000).max(60000).optional(), max_files: z.number().int().min(1).max(2000).optional() }).strict(), args: { path: "string", project: "string", label: "string", max_chars: "number", max_files: "number" }, risk: "medium", category: "Development", handler: async args => { try { return await bundle(services, args); } catch (error) { return { ...out({ ok: false, state: "unavailable", error: error.message || String(error), code: "bundle_failed" }), isError: true }; } } }, { name: "reproducibility_compare", description: "Deterministically compare two reproducibility values through the research comparison authority; no claim of equivalence is inferred.", schema: z.object({ baseline: z.any(), candidate: z.any(), mode: z.enum(["status", "hash", "text", "json", "auto"]).optional() }).strict(), args: { baseline: "any", candidate: "any", mode: "string" }, risk: "low", category: "Development", handler: async args => { const comparison = await services.dispatch("research_compare", { baseline: args.baseline, candidate: args.candidate, mode: args.mode || "auto" }); return out({ ok: !comparison?.isError, comparison, deterministic: true, interpretation_required: true }); } }]; }, healthCheck() { return { ok: true, details: { storage: "research_evidence custody", secret_safe: true, bounded: true, deterministic: true } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
