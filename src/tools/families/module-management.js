"use strict";

const { z } = require("zod");

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function moduleSummary(record, loader) {
  return {
    name: record.name,
    version: record.version,
    state: record.state,
    active_in_process: loader.isModuleActive(record.name),
    tools: Object.keys(record.manifest?.tools || {}),
    error: record.error || null,
  };
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
    return { content: [{ type: "text", text: "name is required for module get/enable/disable" }], isError: true };
  }
  const record = repository.getModule(name);
  if (!record) {
    return { content: [{ type: "text", text: `Module not found: ${name}` }], isError: true };
  }

  if (action === "get") return jsonText({ ok: true, module: moduleSummary(record, loader) });

  if (action === "disable") {
    const result = loader.disableModule(name);
    return jsonText({ ok: true, action, module: moduleSummary(result.module, loader) });
  }

  if (action === "enable") {
    // Lazy-load to avoid the builtin module entry -> family registry cycle
    // while descriptors are being assembled.
    const { builtinEntriesByName } = require("../../modules/builtin-modules");
    const entry = builtinEntriesByName()[name];
    if (!entry) {
      return { content: [{ type: "text", text: `Module "${name}" has no entry in this process` }], isError: true };
    }
    const result = loader.enableModule(name, entry);
    return jsonText({ ok: true, action, module: moduleSummary(result.module, loader) });
  }

  return { content: [{ type: "text", text: `Unknown module action: ${action}. Use list, get, enable, or disable` }], isError: true };
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "module",
    aliases: ["modules"],
    description: "Inspect and operate platform module lifecycle state through the shared policy and approval path",
    schema: z.object({
      action: z.enum(["list", "get", "enable", "disable"]).optional().describe("Module action (default: list)"),
      name: z.string().optional().describe("Module name for get, enable, or disable"),
    }),
    args: { action: "string (list|get|enable|disable - default list)", name: "string (module name for get/enable/disable)" },
    risk: "high",
    category: "Services",
    source: "builtin",
    family: "module-management",
    handler: sidekick_module,
  }),
]);

module.exports = { descriptors, sidekick_module };
