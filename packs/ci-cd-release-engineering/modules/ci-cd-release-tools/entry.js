"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const text = value => value?.content?.map(item => item.text || "").join("\n") || "";
function decode(value, name) { const raw = text(value).trim(); if (!raw) throw new Error(`${name} returned an empty response`); try { return JSON.parse(raw); } catch { throw new Error(`${name} returned invalid JSON`); } }
async function call(services, name, args) { const value = await services.dispatch(name, args); if (value?.isError) throw new Error(`${name} dependency failed`); return value; }
async function readiness(services, args) {
  const mode = args.verification_mode || services.config?.verification_mode || "standard";
  const profile = await call(services, "dev_repo_profile", { path: args.path });
  const verify = await call(services, "dev_verify", { path: args.path, mode, dry_run: true });
  const notes = await call(services, "changelog", { action: "preview", from: args.since, to: "HEAD", format: "markdown", group_by: "type", path: args.path });
  const verification = decode(verify, "dev_verify");
  return result({ ok: verification.verdict !== "failed" && verification.ok !== false, repository_profile: decode(profile, "dev_repo_profile"), verification_plan: verification, release_notes_preview: text(notes), not_performed: ["git push", "tag creation", "release creation", "package publication", "deployment"] });
}
async function gate(services, args) {
  const mode = args.verification_mode || services.config?.verification_mode || "standard";
  const profile = await call(services, "dev_repo_profile", { path: args.path });
  const verification = await call(services, "dev_verify", { path: args.path, mode, dry_run: args.execute !== true, continue_on_failure: false });
  const decoded = decode(verification, "dev_verify");
  return result({ ok: args.execute === true ? decoded.ok === true && decoded.verdict !== "failed" : decoded.ok !== false, repository_profile: decode(profile, "dev_repo_profile"), verification: decoded, execution: { requested: args.execute === true, performed: args.execute === true, mode }, policy: { publish: false, push: false, deploy: false }, provenance: { tools: ["dev_repo_profile", "dev_verify"] } });
}
async function health(services) { const checks = {}; for (const name of ["dev_repo_profile", "dev_verify", "changelog"]) { try { await call(services, name, name === "dev_verify" ? { path: process.cwd(), dry_run: true, intents: ["syntax"] } : name === "dev_repo_profile" ? { path: process.cwd(), include_git: false, include_semantic: false } : { action: "preview", from: "HEAD~1", to: "HEAD", format: "plain", path: process.cwd() }); checks[name] = { ok: true }; } catch (error) { checks[name] = { ok: false, error: error.message }; } } return result({ ok: Object.values(checks).every(item => item.ok), checks, release_mutations: "disabled" }); }
const entry = { buildDescriptors(services) { return [
  { name: "release_readiness", description: "Build a release readiness packet from repository facts, a dry-run verification plan and changelog preview. It never publishes.", schema: z.object({ path: z.string().min(1).max(2048), since: z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/), verification_mode: z.enum(["quick", "standard", "full"]).optional() }).strict(), args: { path: "string", since: "string (tag or commit)", verification_mode: "string" }, risk: "high", category: "Development", handler: args => readiness(services, args) },
  { name: "ci_release_health", description: "Probe the CI/CD pack's repository, verification and changelog dependencies without changing the repository.", schema: z.object({}), args: {}, risk: "low", category: "Development", annotations: { readOnlyHint: true, idempotentHint: true }, handler: () => health(services) },
  { name: "release_gate", description: "Evaluate or execute the governed repository verification path and return a release gate. Publishing, pushing and deployment are never exposed.", schema: z.object({ path: z.string().min(1).max(2048), verification_mode: z.enum(["quick", "standard", "full"]).optional(), execute: z.boolean().optional() }).strict(), args: { path: "string", verification_mode: "string", execute: "boolean (explicitly run verification)" }, risk: "high", category: "Development", handler: args => gate(services, args) },
]; }, healthCheck({ config }) { return { ok: ["quick", "standard", "full"].includes(config?.verification_mode || "standard"), details: { verification_mode: config?.verification_mode || "standard", dependencies: ["dev_repo_profile", "dev_verify", "changelog"], publish_operations: "not exposed" } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
