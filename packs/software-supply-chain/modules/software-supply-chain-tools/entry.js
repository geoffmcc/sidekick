"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const MAX = 200000;
const body = value => String(value?.content?.[0]?.text || value || "").slice(0, MAX);
const failed = value => Boolean(value?.isError);
async function audit(services, args) {
  const manifest = await services.dispatch("parse", { input: args.manifest, format: args.format || "auto" });
  const digest = args.lockfile_path ? await services.dispatch("hash", { path: args.lockfile_path, algorithm: "sha256" }) : null;
  const state = args.repository ? await services.dispatch("git", { action: "status", path: args.repository, args: "--porcelain=v1" }) : null;
  const semantics = args.repository ? await services.dispatch("semantic_repo", { path: args.repository, action: "profile", level: 0, limit: 20, max_chars: 6000, exclude: ["node_modules/**", ".git/**"] }) : null;
   const checks = { manifest: !failed(manifest), lockfile: !failed(digest), repository: !failed(state) && !failed(semantics) };
   return { content: [{ type: "text", text: JSON.stringify({ ok: Object.values(checks).every(Boolean), tool: "supply_chain_audit", checks, manifest: body(manifest), lockfile_sha256: body(digest), git_state: body(state), semantic_boundaries: body(semantics), evidence: { parser: "parse", lockfile: digest ? "sha256" : "not_requested", repository: args.repository ? "git+semantic_repo" : "not_requested" }, limits: { manifest_chars: args.manifest.length, max: services.config.max_manifest_chars || 50000 }, trust: "checks are evidence, not proof that dependencies are safe" }, null, 2).slice(0, MAX) }] };
}
 const entry = { buildDescriptors(services) { return [{ name: "supply_chain_audit", description: "Audit a bounded dependency manifest and optional lockfile/repository provenance using governed parser, hash, Git and semantic tools", schema: z.object({ manifest: z.string().min(2).max(MAX), format: z.enum(["auto", "json", "yaml", "ini", "xml", "csv"]).optional(), lockfile_path: z.string().max(2048).optional(), repository: z.string().max(2048).optional() }).strict(), args: { manifest: "string", format: "string", lockfile_path: "string", repository: "string" }, risk: "low", category: "Security", handler: args => audit(services, args) }]; }, healthCheck({ config }) { return { ok: Number.isInteger(config.max_manifest_chars || 50000) && (config.max_manifest_chars || 50000) <= MAX, details: { max_manifest_chars: config.max_manifest_chars || 50000, deterministic: true } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
