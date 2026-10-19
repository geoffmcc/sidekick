"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const MAX = 200000;
const body = value => String(value?.content?.[0]?.text || value || "").slice(0, MAX);
function parsedResult(value) { try { return JSON.parse(value?.content?.map(item => item.text || "").join("\n") || ""); } catch { return null; } }
const failed = value => { const data = parsedResult(value); const state = String(value?.state || value?.status || data?.state || data?.status || "").toLowerCase(); return value?.isError === true || value?.ok === false || data?.ok === false || ["unavailable", "error", "failed"].includes(state); };
function parseJson(value) { try { return JSON.parse(value?.content?.map(item => item.text || "").join("") || ""); } catch { return null; } }
function sbomFacts(value) {
  const data = parseJson(value);
  const components = Array.isArray(data?.components) ? data.components : [];
  const ids = components.map(item => item.purl || item["bom-ref"] || `${item.group || ""}/${item.name || ""}@${item.version || ""}`);
  return { format: data?.bomFormat || data?.spdxVersion || "unknown", component_count: components.length, missing_versions: components.filter(item => !item.version).length, missing_identifiers: components.filter(item => !item.purl && !item["bom-ref"] && !item.name).length, duplicate_identifiers: ids.filter((id, index) => ids.indexOf(id) !== index).length };
}
async function audit(services, args) {
  const maxManifest = services.config?.max_manifest_chars || 50000;
  if (args.manifest.length > maxManifest) return { content: [{ type: "text", text: JSON.stringify({ ok: false, state: "invalid_input", code: "manifest_too_large", error: `manifest exceeds configured limit (${maxManifest} characters)` }) }], isError: true, code: "manifest_too_large" };
  const manifest = await services.dispatch("parse", { input: args.manifest, format: args.format || "auto" });
  const digest = args.lockfile_path ? await services.dispatch("hash", { path: args.lockfile_path, algorithm: "sha256" }) : null;
  const repoState = args.repository ? await services.dispatch("git", { action: "status", path: args.repository, args: "--porcelain=v1" }) : null;
  const semantics = args.repository ? await services.dispatch("semantic_repo", { path: args.repository, action: "profile", level: 0, limit: 20, max_chars: 6000, exclude: ["node_modules/**", ".git/**"] }) : null;
  const checks = {
    manifest: failed(manifest) ? "unavailable" : "observed",
    lockfile: !args.lockfile_path ? "not_requested" : failed(digest) ? "unavailable" : "observed",
    repository: !args.repository ? "not_requested" : failed(repoState) || failed(semantics) ? "partial" : "observed",
  };
  const requested = Object.values(checks).filter(value => value !== "not_requested");
  const failedCount = requested.filter(value => value !== "observed").length;
  const state = failedCount === requested.length ? "unavailable" : failedCount ? "partial" : "observed";
  return { content: [{ type: "text", text: JSON.stringify({ ok: failedCount === 0, state, tool: "supply_chain_audit", checks, manifest: body(manifest), lockfile_sha256: body(digest), git_state: body(repoState), semantic_boundaries: body(semantics), evidence: { parser: "parse", lockfile: digest ? "sha256" : "not_requested", repository: args.repository ? "git+semantic_repo" : "not_requested" }, limits: { manifest_chars: args.manifest.length, max: maxManifest }, trust: "checks are evidence, not proof that dependencies are safe" }, null, 2).slice(0, MAX) }] };
}
async function provenance(services, args) { try { const parsed = await services.dispatch("parse", { input: args.sbom, format: args.format || "auto" }); const digest = await services.dispatch("hash", { input: args.lockfile, algorithm: "sha256" }); const available = !failed(parsed) && !failed(digest); const facts = available ? sbomFacts(parsed) : null; const shapeValid = facts && facts.format !== "unknown" && facts.component_count > 0; const state = !available ? "unavailable" : shapeValid ? "observed" : "incomplete"; return { content: [{ type: "text", text: JSON.stringify({ ok: available && shapeValid, tool: "supply_chain_provenance", state, sbom: body(parsed), sbom_facts: facts, lockfile_sha256: body(digest), source: args.source || null, claims: ["SBOM was parsed", "lockfile content was hashed"], limitations: ["SBOM shape checks are not schema validation or dependency safety analysis.", "No registry trust, signature, vulnerability, license, or reproducibility verdict is inferred.", "Input provenance and freshness are not independently established."] }, null, 2) }] }; } catch (error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, state: "unavailable", code: "provenance_unavailable", error: String(error.message || error).slice(0, 300) }) }], isError: true }; } }
  const entry = { buildDescriptors(services) { return [{ name: "supply_chain_audit", description: "Audit a bounded dependency manifest and optional lockfile/repository provenance using governed parser, hash, Git and semantic tools", schema: z.object({ manifest: z.string().min(2).max(MAX), format: z.enum(["auto", "json", "yaml", "ini", "xml", "csv"]).optional(), lockfile_path: z.string().max(2048).optional(), repository: z.string().max(2048).optional() }).strict(), args: { manifest: "string", format: "string", lockfile_path: "string", repository: "string" }, risk: "low", category: "Security", handler: args => audit(services, args) }, { name: "supply_chain_provenance", description: "Parse a bounded SBOM and hash supplied lockfile content through governed tools; no package safety claim is made.", schema: z.object({ sbom: z.string().min(2).max(MAX), lockfile: z.string().min(1).max(MAX), format: z.enum(["auto", "json", "yaml", "ini", "xml", "csv"]).optional(), source: z.string().max(500).optional() }).strict(), args: { sbom: "string", lockfile: "string", format: "string", source: "string" }, risk: "low", category: "Security", handler: args => provenance(services, args) }]; }, healthCheck({ config }) { return { ok: Number.isInteger(config.max_manifest_chars || 50000) && (config.max_manifest_chars || 50000) <= MAX, details: { max_manifest_chars: config.max_manifest_chars || 50000, deterministic: true, sbom_analysis: "parse-only" } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
