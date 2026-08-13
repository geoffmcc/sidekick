"use strict";

const { z } = require("zod");

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function moduleSummary(record, loader) {
  const repository = require("../../modules/repository");
  return {
    name: record.name,
    version: record.version,
    state: record.state,
    source: record.source,
    // Managed (installed) modules run from the Sidekick-owned module store and
    // carry an integrity hash; builtin modules ship inside the repository.
    managed: Boolean(record.install_path),
    install_path: record.install_path || null,
    package_hash: record.package_hash || null,
    provenance: record.provenance || {},
    active_in_process: loader.isModuleActive(record.name),
    tools: Object.keys(record.manifest?.tools || {}),
    error: record.error || null,
    health: record.health || {},
    last_health_check_at: record.last_health_check_at || null,
    health_history: repository.listHealthHistory(record.name),
  };
}

/**
 * Resolve a module's entry for this process.
 *
 * Covers BOTH sources: builtin entries that ship in the repository, and
 * installed modules loaded from the managed store through the verified entry
 * loader. Before B9 this looked only at builtin entries, so an operator could
 * not enable, health-check or recover an installed third-party module through
 * the management surface at all.
 */
function resolveEntry(record) {
  return require("../../modules/entries").resolveModuleEntry(record);
}

async function sidekick_module({ action = "list", name }) {
  // Keep module runtime dependencies lazy: this family is loaded while the
  // registry itself is being assembled, and eager imports can create a second
  // partially-initialized loader through the registry -> family cycle.
  const repository = require("../../modules/repository");
  const loader = require("../../modules/loader");
  if (action === "list") {
    return jsonText({ ok: true, modules: repository.listModules().map(record => moduleSummary(record, loader)) });
  }

  if (!name) {
    return { content: [{ type: "text", text: "name is required for module get/health/enable/disable" }], isError: true };
  }
  const record = repository.getModule(name);
  if (!record) {
    return { content: [{ type: "text", text: `Module not found: ${name}` }], isError: true };
  }

  if (action === "get") return jsonText({ ok: true, module: moduleSummary(record, loader) });

  if (action === "health") return jsonText({ ok: true, module: moduleSummary(record, loader) });

  if (action === "status") {
    // Derived, component-level health (integrity, compatibility, configuration,
    // in-process activation) rather than the last stored payload.
    const { health } = require("../../modules/lifecycle");
    return jsonText({ ok: true, action, health: health(name, { runCheck: false }) });
  }

  if (action === "check") {
    const resolved = resolveEntry(record);
    if (!resolved.ok) {
      return { content: [{ type: "text", text: `Module "${name}" has no health entry in this process: ${resolved.error}` }], isError: true };
    }
    const { checkModuleHealth } = require("../../modules/health");
    return jsonText({ ok: true, action, result: checkModuleHealth(name, resolved.entry) });
  }

  if (action === "recover") {
    const resolved = resolveEntry(record);
    if (!resolved.ok) {
      return { content: [{ type: "text", text: `Module "${name}" has no recovery entry in this process: ${resolved.error}` }], isError: true };
    }
    const { recoverModuleHealth } = require("../../modules/health");
    return jsonText({ ok: true, action, result: recoverModuleHealth(name, resolved.entry) });
  }

  if (action === "disable") {
    const result = loader.disableModule(name);
    return jsonText({ ok: true, action, module: moduleSummary(result.module, loader) });
  }

  if (action === "enable") {
    // Resolution is lazy for two reasons: it avoids the builtin module entry ->
    // family registry cycle while descriptors are being assembled, and for a
    // managed module it is the point at which integrity, compatibility and
    // configuration are verified before any code loads.
    const resolved = resolveEntry(record);
    if (!resolved.ok) {
      return { content: [{ type: "text", text: `Module "${name}" cannot be enabled in this process: ${resolved.error}` }], isError: true };
    }
    const result = loader.enableModule(name, resolved.entry);
    return jsonText({ ok: true, action, module: moduleSummary(result.module, loader) });
  }

  return { content: [{ type: "text", text: `Unknown module action: ${action}. Use list, get, health, status, check, recover, enable, or disable` }], isError: true };
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "module",
    aliases: ["modules"],
    description: "Inspect and operate platform module lifecycle state through the shared policy and approval path",
    schema: z.object({
      action: z.enum(["list", "get", "health", "status", "check", "recover", "enable", "disable"]).optional().describe("Module action (default: list)"),
      name: z.string().optional().describe("Module name for get, health, status, check, recover, enable, or disable"),
    }),
    args: { action: "string (list|get|health|status|check|recover|enable|disable - default list)", name: "string (module name for get/health/status/check/recover/enable/disable)" },
    risk: "high",
    category: "Services",
    source: "builtin",
    family: "module-management",
    handler: sidekick_module,
  }),
]);

module.exports = { descriptors, sidekick_module };
