"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
async function call(services, name, args) { const value = await services.dispatch(name, args); if (value?.isError) { const error = new Error(`${name} dependency failed`); error.code = value.code || "dependency_failed"; throw error; } return value; }
function targetUrl(value) { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("URL must be HTTP(S) without credentials or fragments"); return url; }
async function contract(services, args) {
  try { targetUrl(args.url); } catch (error) { return result({ ok: false, code: "invalid_target", error: error.message }); }
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(args.network_scope || "")) return result({ ok: false, code: "network_scope_required", error: "API targets require an exact named network scope" });
  if (!Array.isArray(args.assertions) || args.assertions.length === 0) return result({ ok: false, code: "assertions_required", error: "at least one deterministic assertion is required" });
  const assertions = args.assertions.slice(0, Math.max(1, Math.min(50, Number(services.config?.max_assertions) || 20)));
  const check = await call(services, "web_check", { url: args.url, assertions, allowed_hosts: args.allowed_hosts, network_scope: args.network_scope, capture_evidence: args.capture_evidence === true, project: args.project, wait_until: "domcontentloaded" });
  return result({ ok: !check.isError, contract: check, target: args.url, network_scope: args.network_scope, bounded: { assertions: assertions.length }, mutation: "none" });
}
async function health(services, args) { if (!args.network_scope) return result({ ok: false, code: "network_scope_required", error: "health probes also require a named network scope" }); try { const check = await call(services, "web_check", { url: args.url, assertions: [{ kind: "url_contains", value: new URL(args.url).host }], allowed_hosts: args.allowed_hosts, network_scope: args.network_scope, wait_until: "domcontentloaded" }); return result({ ok: !check.isError, check, network_scope: args.network_scope }); } catch (error) { return result({ ok: false, error: error.message, network_scope: args.network_scope }); } }
async function matrix(services, args) {
  const results = [];
  const maxTargets = Math.max(1, Math.min(10, Number(services.config?.max_targets) || 10));
  for (const target of args.targets.slice(0, maxTargets)) {
    try {
      targetUrl(target.url);
      const check = await call(services, "web_check", { url: target.url, assertions: target.assertions, allowed_hosts: args.allowed_hosts, network_scope: args.network_scope, capture_evidence: args.capture_evidence === true, project: args.project, wait_until: "domcontentloaded" });
      results.push({ url: target.url, ok: !check.isError, check });
    } catch (error) {
      results.push({ url: target.url, ok: false, code: error.code || "probe_failed", error: String(error.message || error).slice(0, 300) });
    }
  }
  const allPassed = results.length > 0 && results.every(item => item.ok);
  return result({ ok: allPassed, status: allPassed ? "succeeded" : results.some(item => item.ok) ? "partial" : "failed", tool: "api_contract_matrix", network_scope: args.network_scope, results, bounded: { targets: results.length, max_targets: maxTargets } });
}
const entry = { buildDescriptors(services) { return [
   { name: "api_contract_check", description: "Run bounded deterministic API assertions through the governed browser HTTP path. Private targets require a named network scope.", schema: z.object({ url: z.string().url(), network_scope: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), assertions: z.array(z.object({ kind: z.enum(["url_contains", "title_contains", "text_visible", "element_visible", "element_absent", "value_equals", "checked", "count"]), target: z.union([z.string(), z.object({ kind: z.string(), value: z.string() }).strict()]).optional(), value: z.union([z.string(), z.number(), z.boolean()]).optional() }).strict()).min(1).max(50), allowed_hosts: z.array(z.string().regex(/^[A-Za-z0-9*.-]+$/)).max(32).optional(), capture_evidence: z.boolean().optional(), project: z.string().max(100).optional() }).strict(), args: { url: "string (HTTP/HTTPS API target)", network_scope: "string (operator-created named scope)", assertions: "array (deterministic assertions)" }, risk: "high", category: "Development", handler: args => contract(services, args) },
   { name: "api_engineering_health", description: "Run one bounded API health assertion through a named outbound network scope.", schema: z.object({ url: z.string().url(), network_scope: z.string().min(1).max(80), allowed_hosts: z.array(z.string()).max(32).optional() }).strict(), args: { url: "string", network_scope: "string", allowed_hosts: "array" }, risk: "low", category: "Development", handler: args => health(services, args) },
   { name: "api_contract_matrix", description: "Evaluate a bounded set of API contracts independently through the governed browser path; one failed target does not hide evidence from the others.", schema: z.object({ network_scope: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), targets: z.array(z.object({ url: z.string().url(), assertions: z.array(z.object({ kind: z.enum(["url_contains", "title_contains", "text_visible", "element_visible", "element_absent", "value_equals", "checked", "count"]), target: z.union([z.string(), z.object({ kind: z.string(), value: z.string() }).strict()]).optional(), value: z.union([z.string(), z.number(), z.boolean()]).optional() }).strict()).min(1).max(20) }).strict()).min(1).max(10), allowed_hosts: z.array(z.string().regex(/^[A-Za-z0-9*.-]+$/)).max(32).optional(), capture_evidence: z.boolean().optional(), project: z.string().max(100).optional() }).strict(), args: { network_scope: "string", targets: "array (maximum 10)", allowed_hosts: "array", capture_evidence: "boolean", project: "string" }, risk: "high", category: "Development", handler: args => matrix(services, args) },
  ]; }, healthCheck({ config }) { const maxAssertions = Number(config?.max_assertions || 20); const maxTargets = Number(config?.max_targets || 10); return { ok: Number.isInteger(maxAssertions) && maxAssertions > 0 && maxAssertions <= 50 && Number.isInteger(maxTargets) && maxTargets > 0 && maxTargets <= 10, details: { max_assertions: maxAssertions, max_targets: maxTargets, dependencies: ["web_check"], network_policy: "named network scope required for every target" } }; } };
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
