"use strict";

// Recipes are source-derived safety contracts, not proof. Execution results are
// only proof after the canonical dispatcher and receipt verifier validate them.
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const packsRoot = path.join(root, "packs");
const output = path.join(root, "docs", "proving-recipes.json");
const bounded = (value, max) => String(value || "").slice(0, max);
const packs = fs.readdirSync(packsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => {
    const dir = path.join(packsRoot, entry.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "sidekick.pack.json"), "utf8"));
    const tools = [];
    for (const module of manifest.modules || []) {
      const moduleManifest = JSON.parse(fs.readFileSync(path.join(dir, module.path, "manifest.json"), "utf8"));
      tools.push(...Object.keys(moduleManifest.tools || {}));
    }
    return {
      id: `pack-proving.${manifest.name}`,
      version: 1,
      pack: manifest.name,
      supported_versions: `=${bounded(manifest.version, 64)}`,
      preconditions: ["pack package hash is inspectable", "pack configuration validates", "pack lifecycle is enabled for dispatch checks"],
      required_configuration: manifest.configuration?.schema ? "manifest.configuration.schema" : null,
      live_provider_required: Boolean(manifest.provider_requirements),
      required_network_scopes: [],
      discovery: ["capability.catalog", "capability.show", "capability.health"],
      single_pack: tools.slice(0, 8).map(tool => ({ capability: tool, dispatch: "canonical", mutation: false })),
      cross_pack: [],
      negative_checks: ["schema rejection", "unavailable-provider behavior", "redaction", "stale evidence invalidation", "configuration-change invalidation", "lifecycle-change invalidation"],
      expected_evidence: ["receipt", "workflow or execution", "verification report"],
      independent_verification: ["re-read receipt terminal state", "recompute package/config/lifecycle fingerprints", "verify evidence freshness and provenance"],
      cleanup: { required: true, idempotent: true, mutations: "none unless explicitly approved" },
      mutation_policy: "read_only_by_default",
      bounds: { timeout_ms: 120000, max_steps: 8, max_retries: 1 },
      unavailable_outcome: manifest.provider_requirements ? "unavailable_not_certified" : "not_evaluated_without_dispatch_evidence",
    };
  })
  .sort((a, b) => a.pack.localeCompare(b.pack));
const report = { schema: "sidekick.pack-proving-recipes.v1", recipe_version: 1, source: "bundled pack manifests", pack_count: packs.length, recipes: packs };
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ ok: true, output: "docs/proving-recipes.json", recipe_count: packs.length }) + "\n");
