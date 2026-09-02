"use strict";

// Capability-pack tool family: capability.
//
// The single operator/agent surface for capability-pack lifecycle. Every
// action routes through the normal descriptor + dispatcher path, so policy,
// approval, timeouts, redaction and audit logging all apply — installing or
// activating third-party executable code is emphatically not a read-only
// operation, and the descriptor's `critical` risk says so.
//
// This family owns no lifecycle logic of its own: it validates and shapes
// arguments, then delegates to src/packs/lifecycle.js and src/packs/bundled.js.

const { z } = require("zod");

function jsonText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function failure(message, extra = {}) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }], isError: true };
}

function requireName(name, action) {
  if (!name) throw new Error(`name is required for capability action "${action}"`);
  return String(name);
}

async function sidekick_capability({ action = "list", name, path: sourcePath, config, enable, allow_same_version, allow_downgrade, remove_knowledge, remove_module_data, source, query, kind, owner, state, available, offset, limit }) {
  // Lazy requires: this family is loaded while the registry is assembled, and
  // the pack lifecycle reaches back into the module loader and tool registry.
  const lifecycle = require("../../packs/lifecycle");
  const repository = require("../../packs/repository");
  const bundled = require("../../packs/bundled");

  try {
    if (action === "catalog") return jsonText(require("../../capabilities/catalog").project({ source, query, kind, owner, state, available, offset, limit }));

    if (action === "list") {
      const installed = repository.listPacks().map(pack => lifecycle.describe(pack.name, { includeHealth: true }));
      const available = bundled.listBundledPacks().filter(pack => !pack.installed);
      return jsonText({
        ok: true,
        action,
        installed: installed.map(pack => ({
          name: pack.name,
          display_name: pack.display_name,
          version: pack.version,
          publisher: pack.publisher,
          provenance: pack.provenance,
          bundled: pack.bundled,
          state: pack.state,
          enabled: pack.enabled,
          health: pack.health.status,
          maturity: pack.maturity,
          modules: pack.modules.map(m => m.name),
          tools: pack.tools,
          workflows: pack.workflows.map(w => w.name),
          knowledge: pack.knowledge.length,
        })),
        available_bundled: available,
      });
    }

    if (action === "available") {
      return jsonText({ ok: true, action, bundled: bundled.listBundledPacks() });
    }

    if (action === "show") {
      const pack = lifecycle.describe(requireName(name, action));
      if (!pack) return failure(`Capability pack "${name}" is not installed`, { code: "not_installed" });
      return jsonText({ ok: true, action, pack });
    }

    if (action === "inspect") {
      // Inspection of a bundled pack by name, or of a server-local package path.
      let target = sourcePath;
      if (!target && name) {
        const candidate = bundled.getBundledPack(name);
        if (!candidate) return failure(`No bundled capability pack named "${name}" and no path supplied`, { code: "not_found" });
        target = candidate.path;
      }
      if (!target) return failure("inspect requires either a bundled pack name or a server-local path", { code: "invalid_arguments" });
      return jsonText({ ok: true, action, inspection: lifecycle.inspect(target) });
    }

    if (action === "validate") {
      // Structured contract validation of a bundled pack or a server-local
      // package path: file/field/problem/correction findings, no install.
      let target = sourcePath;
      if (!target && name) {
        const candidate = bundled.getBundledPack(name);
        if (!candidate) return failure(`No bundled capability pack named "${name}" and no path supplied`, { code: "not_found" });
        target = candidate.path;
      }
      if (!target) return failure("validate requires either a bundled pack name or a server-local path", { code: "invalid_arguments" });
      const report = lifecycle.validate(target);
      return jsonText({ ok: report.valid, action, report });
    }

    if (action === "install") {
      const result = sourcePath
        ? lifecycle.install(sourcePath, { config, enable: enable === true, provenance: "third_party", source: { kind: "local_path" } })
        : bundled.installBundledPack(requireName(name, action), { config, enable: enable === true });
      return jsonText({
        ok: true,
        action,
        pack: lifecycle.describe(result.pack.name),
        install_path: result.install_path,
        components: result.components,
      });
    }

    if (action === "configure") {
      const result = lifecycle.configure(requireName(name, action), config || {});
      return jsonText({ ok: true, action, pack: lifecycle.describe(result.pack.name), propagated_to_modules: result.propagated_to_modules });
    }

    if (action === "enable") {
      const result = lifecycle.enable(requireName(name, action));
      return jsonText({ ok: true, action, pack: lifecycle.describe(result.pack.name), activated: result.activated });
    }

    if (action === "disable") {
      const result = lifecycle.disable(requireName(name, action));
      return jsonText({ ok: true, action, pack: lifecycle.describe(result.pack.name), deactivated: result.deactivated });
    }

    if (action === "health") {
      const report = lifecycle.health(requireName(name, action));
      repository.recordPackHealth(name, report);
      return jsonText({ ok: report.ok, action, health: report });
    }

    if (action === "maturity") {
      const report = lifecycle.maturity(requireName(name, action));
      return jsonText({ ok: true, action, maturity: report });
    }

    if (action === "prove") {
      const { runRecipe } = require("../../proving/runner");
      return jsonText({ ok: true, action, proving: await runRecipe(requireName(name, action), { project: "pack-proving", actor: "capability-proving" }) });
    }

    if (action === "record_verification") {
      const result = lifecycle.recordVerification(requireName(name, action), config || {});
      return jsonText({ ok: true, action, ...result });
    }

    if (action === "doctor") {
      const report = lifecycle.doctor(requireName(name, action));
      repository.recordPackHealth(name, report.health);
      return jsonText({ ok: report.ok, action, doctor: report });
    }

    if (action === "upgrade") {
      const packName = requireName(name, action);
      const options = { allowSameVersion: allow_same_version === true, allowDowngrade: allow_downgrade === true, config };
      const result = sourcePath
        ? lifecycle.upgrade(packName, sourcePath, options)
        : bundled.upgradeBundledPack(packName, options);
      return jsonText({
        ok: true,
        action,
        pack: lifecycle.describe(result.pack.name),
        previous_version: result.previous_version,
        version: result.version,
      });
    }

    if (action === "uninstall") {
      const result = lifecycle.uninstall(requireName(name, action), {
        removeKnowledge: remove_knowledge !== false,
        removeModuleData: remove_module_data === true,
      });
      return jsonText({ ok: true, action, result });
    }

    return failure(
      `Unknown capability action: ${action}. Use list, catalog, available, show, inspect, validate, install, configure, enable, disable, health, maturity, prove, record_verification, doctor, upgrade, or uninstall`,
      { code: "unknown_action" }
    );
  } catch (error) {
    return failure(String(error && error.message ? error.message : error), {
      action,
      code: error && error.code ? error.code : "capability_operation_failed",
      failures: error && error.failures ? error.failures : undefined,
    });
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "capability",
    aliases: ["capability_pack", "pack"],
    description:
      "Inspect the shared Sidekick capability catalog and manage installed or bundled packs. Installing or enabling a pack activates executable module code in the Sidekick process.",
    schema: z.object({
      action: z
        .enum(["list", "catalog", "available", "show", "inspect", "validate", "install", "configure", "enable", "disable", "health", "maturity", "prove", "record_verification", "doctor", "upgrade", "uninstall"])
        .optional()
        .describe("Capability pack action (default: list)"),
      name: z.string().optional().describe("Pack name (required for show/configure/enable/disable/health/upgrade/uninstall, and for installing a bundled pack)"),
      path: z.string().optional().describe("Server-local package path for inspect/validate/install/upgrade of a non-bundled pack"),
      config: z.record(z.any()).optional().describe("Pack configuration or attributed verification object"),
      enable: z.boolean().optional().describe("Enable the pack immediately after install (default false)"),
      allow_same_version: z.boolean().optional().describe("Permit replacing the installed version with the same version (upgrade)"),
      allow_downgrade: z.boolean().optional().describe("Permit moving to a lower version (upgrade)"),
      remove_knowledge: z.boolean().optional().describe("Remove the pack's knowledge entries on uninstall (default true)"),
      source: z.string().optional().describe("Consumer source for catalog policy projection"),
      query: z.string().max(200).optional().describe("Catalog text filter"),
      kind: z.enum(["pack", "module", "tool", "workflow"]).optional().describe("Catalog entry kind filter"),
      owner: z.string().optional().describe("Catalog owner filter"),
      state: z.string().optional().describe("Catalog lifecycle state filter"),
      available: z.boolean().optional().describe("Catalog availability filter"),
      offset: z.number().int().min(0).max(1000000).optional().describe("Catalog offset"),
      limit: z.number().int().min(1).max(500).optional().describe("Catalog page size"),
      remove_module_data: z.boolean().optional().describe("Request removal of module-owned data on uninstall, where the module's manifest permits it (default false)"),
    }),
    args: {
       action: "string (list|catalog|available|show|inspect|validate|install|configure|enable|disable|health|maturity|prove|record_verification|doctor|upgrade|uninstall - default list)",
      name: "string (pack name)",
      path: "string (server-local package path)",
      config: "object (pack configuration)",
      enable: "boolean (enable immediately after install)",
      allow_same_version: "boolean (upgrade: allow same-version replacement)",
      allow_downgrade: "boolean (upgrade: allow downgrade)",
      remove_knowledge: "boolean (uninstall: remove knowledge entries, default true)",
      remove_module_data: "boolean (uninstall: remove module-owned data where permitted)",
      source: "string (catalog policy source)", query: "string (catalog filter)", kind: "string (pack|module|tool|workflow)", owner: "string (catalog owner)", state: "string (catalog state)", available: "boolean (catalog availability)", offset: "number", limit: "number",
    },
    risk: "critical",
    category: "Services",
    source: "builtin",
    family: "capability-packs",
    handler: sidekick_capability,
  }),
]);

module.exports = { descriptors, sidekick_capability };
