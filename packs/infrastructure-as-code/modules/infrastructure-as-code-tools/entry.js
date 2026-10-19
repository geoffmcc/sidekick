"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
function payload(value) { const raw = value?.content?.map(item => item.text || "").join("\n").trim(); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
function failed(value) { const data = payload(value); const state = String(value?.state || value?.status || data?.state || data?.status || "").toLowerCase(); return value?.isError === true || value?.ok === false || data?.ok === false || ["unavailable", "error", "failed"].includes(state); }
async function call(services, name, args) { const value = await services.dispatch(name, args); if (failed(value)) { const error = new Error(`${name} dependency failed or returned incomplete evidence`); error.code = value?.code || payload(value)?.code || "dependency_failed"; throw error; } return value; }
function parsed(value, name) { const raw = value?.content?.map(item => item.text || "").join("\n").trim(); if (!raw) throw new Error(`${name} returned an empty response`); try { return JSON.parse(raw); } catch { throw new Error(`${name} returned invalid JSON`); } }
async function plan(services, args) {
  const preflight = await call(services, "compose", { action: "preflight", profile: args.profile, file: args.file });
  let parsed = null;
  if (args.manifest) { const value = await call(services, "parse", { input: args.manifest, format: args.format }); parsed = parsedValue(value, "parse"); }
  return result({ ok: true, state: "preflight_observed", plan_only: true, provider_preflight: payload(preflight), parsed_manifest: parsed, target: { profile: args.profile || null, file: args.file || null }, not_performed: ["compose update", "container lifecycle", "network changes", "apply", "destroy"] });
}
function parsedValue(value, name) { return parsed(value, name); }
async function health(services) { try { const value = await call(services, "compose", { action: "projects", profile: undefined }); return result({ ok: !value.isError, dependency: "compose", evidence: value, plan_only: true }); } catch (error) { return result({ ok: false, error: error.message, plan_only: true }); } }
async function inspect(services, args) {
  try {
    const value = await call(services, "compose", { action: args.action, profile: args.profile, file: args.file });
    return result({ ok: true, state: "observed", action: args.action, target: { profile: args.profile || null, file: args.file || null }, provider_result: parsed(value, "compose"), evidence: [{ source: "compose", action: args.action }], not_performed: ["apply", "destroy"] });
  } catch (error) { return result({ ok: false, action: args.action, code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300), evidence: [] }); }
}
const entry = { buildDescriptors(services) { return [
   { name: "iac_plan", description: "Produce a provider preflight and optional parsed manifest. The returned preflight is evidence for review, not an apply-ready infrastructure plan; this tool cannot apply changes.", schema: z.object({ profile: z.string().regex(/^[a-zA-Z0-9_.-]{1,63}$/).optional().describe("Exact configured Compose profile; omit only when the default is intentional."), file: z.string().max(500).optional().describe("Compose file beneath the selected profile's configured project root."), manifest: z.string().max(100000).optional().describe("Optional bounded manifest text to parse; parsing does not apply or validate provider behavior."), format: z.enum(["json", "yaml", "ini", "xml", "csv"]).optional().describe("Declared manifest format; defaults to parser auto-detection.") }).strict().refine(value => value.profile || value.file || value.manifest, { message: "profile, file, or manifest is required" }), args: { profile: "string (configured Compose profile)", file: "string (Compose file beneath configured project root)", manifest: "string (bounded manifest text; parse only)", format: "string (declared input format)" }, risk: "medium", category: "Infrastructure", handler: args => plan(services, args) },
   { name: "iac_health", description: "Probe configured Compose inspection and report plan-only capability state.", schema: z.object({}), args: {}, risk: "low", category: "Infrastructure", annotations: { readOnlyHint: true, idempotentHint: true }, handler: () => health(services) },
   { name: "iac_inspect", description: "Run one explicit provider-authoritative Compose validation or diff without applying changes.", schema: z.object({ action: z.enum(["validate", "diff"]), profile: z.string().regex(/^[a-zA-Z0-9_.-]{1,63}$/).optional(), file: z.string().max(500).optional() }).strict().refine(value => value.profile || value.file, { message: "profile or file is required" }), args: { action: "string", profile: "string", file: "string" }, risk: "low", category: "Infrastructure", annotations: { readOnlyHint: true, idempotentHint: true }, handler: args => inspect(services, args) },
]; }, healthCheck({ config }) { return { ok: config?.allow_apply === false || config?.allow_apply === undefined, details: { plan_only: true, dependencies: ["compose", "parse"], apply: "disabled by pack contract" } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
