"use strict";

// Read-only view over the existing lifecycle, repository, registry and policy
// authorities. It does not execute handlers or grant authority.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function bounded(value, fallback, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}

function packOwner(kind, name) {
  const component = require("../packs/repository").findComponentOwner(kind, name);
  return component ? { kind: "pack", name: component.pack_name } : { kind: "core", name: null };
}

function packRows() {
  const repository = require("../packs/repository");
  const lifecycle = require("../packs/lifecycle");
  const bundled = require("../packs/bundled");
  const installed = new Set(repository.listPacks().map(pack => pack.name));
  const rows = repository.listPacks().map(pack => {
    const detail = lifecycle.describe(pack.name, { includeHealth: true });
    const enabled = detail.enabled === true && detail.health?.ok === true;
    return { kind: "pack", id: pack.name, name: pack.name, owner: { kind: "core", name: null }, state: detail.state, available: enabled, availability: { state: enabled ? "available" : "unavailable", reasons: enabled ? [] : [`pack_state:${detail.state}`, ...(detail.health?.ok ? [] : [`health:${detail.health?.status || "unknown"}`])] }, version: detail.version, description: detail.description, dependencies: detail.depends, configuration: detail.configuration, health: detail.health, maturity: detail.maturity, permissions: detail.permissions, network_scopes: [], components: { modules: detail.modules, tools: detail.tools, workflows: detail.workflows, knowledge: detail.knowledge }, provenance: detail.provenance };
  });
  for (const candidate of bundled.listBundledPacks()) {
    if (installed.has(candidate.name)) continue;
    rows.push({ kind: "pack", id: candidate.name, name: candidate.name, owner: { kind: "core", name: null }, state: "not_installed", available: false, availability: { state: "unavailable", reasons: ["not_installed"] }, version: candidate.version, description: candidate.description || null, dependencies: candidate.depends || { declared: [], resolutions: [], dependents: [] }, configuration: { schema: null, values: {}, valid: null }, health: { status: "not_installed", ok: false }, permissions: candidate.permissions || { declared: null, derived: [], consistent: null }, network_scopes: [], components: { modules: candidate.modules || [], tools: [], workflows: candidate.workflows || [], knowledge: candidate.knowledge || 0 }, provenance: candidate.provenance || "first_party", bundled: true });
  }
  return rows;
}

function moduleRows() {
  const repository = require("../modules/repository");
  const lifecycle = require("../modules/lifecycle");
  const packs = require("../packs/repository");
  return repository.listModules().map(record => {
    const health = lifecycle.health(record.name, { runCheck: false });
    const manifest = record.manifest || {};
    const available = ["enabled", "healthy"].includes(record.state) && health.ok;
    return { kind: "module", id: record.name, name: record.name, owner: packOwner("module", record.name), state: record.state, available, availability: { state: available ? "available" : "unavailable", reasons: available ? [] : [`module_state:${record.state}`, ...(health.ok ? [] : [`health:${health.status}`])] }, version: record.version, description: record.description, dependencies: { required: manifest.dependencies || [], optional: manifest.optionalDependencies || [] }, configuration: { schema: manifest.configSchema || null, values: record.config || {}, valid: health.components?.find(item => item.component === "configuration")?.ok ?? null }, health, permissions: manifest.permissions || [], network_scopes: manifest.networkScopes || [], components: { tools: Object.keys(manifest.tools || {}), workflows: manifest.workflows || [] } };
  });
}

function toolRows(source) {
  const tools = require("../tools");
  const registry = tools.getBuiltinRegistry();
  const packs = require("../packs/repository");
  const modules = require("../modules/repository");
  const moduleLifecycle = require("../modules/lifecycle");
  const rows = registry.listInDefinitionOrder().map(descriptor => ({ descriptor, generated: null }));
  for (const generated of require("../db").listGeneratedCapabilities({ states: ["trial", "active"] })) rows.push({ generated, descriptor: { name: generated.name, description: generated.description, risk: generated.risk, source: "generated", family: "generated", aliases: [], capabilities: [] } });
  return rows.map(({ descriptor, generated }) => {
    const moduleName = String(descriptor.source || "").startsWith("module:") ? descriptor.source.slice(7) : null;
    const module = moduleName ? modules.getModule(moduleName) : null;
    const moduleHealth = moduleName ? moduleLifecycle.health(moduleName, { runCheck: false }) : null;
    const policy = tools.getToolPolicyDecision ? tools.getToolPolicyDecision(descriptor.name, source) : { allowed: true, reason: "not_available" };
    const approval = tools.getApprovalDecision ? tools.getApprovalDecision(descriptor.name, source) : { required: false, reason: "not_available" };
    const live = !generated || ["trial", "active"].includes(generated.state);
    const moduleAvailable = !module || (["enabled", "healthy"].includes(module.state) && moduleHealth?.ok === true);
    const available = live && policy.allowed === true && moduleAvailable;
    return { kind: "tool", id: descriptor.name, name: descriptor.name, owner: moduleName ? packOwner("module", moduleName) : packOwner("tool", descriptor.name), state: generated?.state || module?.state || "registered", available, availability: { state: available ? "available" : "unavailable", reasons: [...(!live ? [`generated_state:${generated.state}`] : []), ...(policy.allowed ? [] : [`policy:${policy.reason}`]), ...(module && !["enabled", "healthy"].includes(module.state) ? [`module_state:${module.state}`] : []), ...(module && module.state !== "disabled" && moduleHealth?.ok !== true ? [`module_health:${moduleHealth?.status || "unknown"}`] : [])] }, version: descriptor.version || generated?.version || null, description: descriptor.description, dependencies: { placement: descriptor.placement?.requirements || {}, module: module?.manifest?.dependencies || [] }, configuration: module ? { schema: module.manifest?.configSchema || null, values: module.config || {} } : null, health: module ? moduleHealth || module.health || {} : { status: live ? "registered" : "unavailable" }, permissions: module?.manifest?.permissions || (descriptor.authorizationPermission ? [{ capability: descriptor.authorizationPermission }] : []), network_scopes: descriptor.placement?.requirements?.networkScopes || [], policy: { source, allowed: policy.allowed === true, reason: policy.reason || null, approval_required: approval.required === true, approval_reason: approval.reason || null }, risk: descriptor.risk, effects: require("../tools/metadata").getToolEffectMetadata(descriptor.name), category: descriptor.category, capabilities: descriptor.capabilities || [], aliases: descriptor.aliases || [] };
  });
}

function workflowRows() {
  const definitions = require("../workflows/repository").listWorkflowDefinitions();
  const packRepository = require("../packs/repository");
  const packLifecycle = require("../packs/lifecycle");
  const registry = require("../tools").getBuiltinRegistry();
  const agentTools = new Map(toolRows("agent").map(row => [row.name, row]));
  return definitions.map(record => {
    const reasons = [];
    if (record.state !== "registered") reasons.push(`workflow_state:${record.state}`);
    if (record.owner_kind === "pack") {
      const owner = packRepository.getPack(record.owner_name);
      if (!owner) reasons.push(`owner_pack_missing:${record.owner_name}`);
      else if (owner.state !== "enabled") reasons.push(`owner_pack_state:${owner.state}`);
      else {
        const health = packLifecycle.describe(record.owner_name, { includeHealth: true }).health;
        if (health?.ok !== true) reasons.push(`owner_pack_health:${health?.status || "unknown"}`);
      }
    }
    const steps = (record.definition.steps || []).map(step => {
      const descriptor = registry.get(step.tool);
      const canonical = descriptor?.name || null;
      const capability = canonical ? agentTools.get(canonical) : null;
      const reason = !descriptor ? "not_registered" : !capability ? "not_agent_visible" : !capability.available ? (capability.availability.reasons.join(",") || "unavailable") : null;
      if (reason) reasons.push(`step:${step.name}:${step.tool}:${reason}`);
      return { step: step.name, requested: step.tool, canonical, available: !reason, reason };
    });
    const available = reasons.length === 0;
    return {
      kind: "workflow", id: record.name, name: record.name,
      owner: { kind: record.owner_kind, name: record.owner_name || null },
      state: record.state, available,
      availability: { state: available ? "available" : "unavailable", reasons },
      version: record.version, description: record.description,
      dependencies: { steps }, configuration: { inputs: record.definition.inputs || {} },
      effects: require("../workflows/effects").analyzeWorkflowEffects(record.definition),
      health: { status: available ? "registered" : "unavailable", ok: available },
      permissions: [], network_scopes: [],
      definition: { mode: record.mode, title: record.title, tags: record.definition.tags || [] },
    };
  });
}

function project(options = {}) {
  const source = String(options.source || "agent");
  let entries = [...packRows(), ...moduleRows(), ...toolRows(source), ...workflowRows()];
  const query = String(options.query || "").trim().toLowerCase();
  const kind = options.kind ? String(options.kind).toLowerCase() : null;
  const state = options.state ? String(options.state).toLowerCase() : null;
  const owner = options.owner ? String(options.owner).toLowerCase() : null;
  entries = entries.filter(entry => (!kind || entry.kind === kind) && (!state || entry.state === state) && (!owner || entry.owner.kind === owner || entry.owner.name?.toLowerCase() === owner) && (options.available === undefined || entry.available === (options.available === true || options.available === "true")) && (!query || `${entry.name} ${entry.description || ""} ${entry.kind} ${entry.owner.name || ""}`.toLowerCase().includes(query))).sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
  const offset = bounded(options.offset, 0, 1000000);
  const limit = bounded(options.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
  return { ok: true, source, total: entries.length, offset, limit, has_more: offset + limit < entries.length, entries: entries.slice(offset, offset + limit) };
}

module.exports = { project, DEFAULT_LIMIT, MAX_LIMIT };
