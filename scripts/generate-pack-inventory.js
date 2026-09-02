"use strict";

// Generates a bounded, source-derived audit matrix. It intentionally reports
// evidence gaps instead of inferring maturity from filenames or manifest shape.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packsRoot = path.join(root, "packs");
const testsRoot = path.join(root, "test");
const output = path.join(root, "docs", "compatibility-pack-inventory.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function operationClass(permission) {
  const risk = String(permission.risk || "low").toLowerCase();
  const tool = String(permission.tool || permission.capability || "");
  const mutating = /add|apply|cancel|change|configure|create|delete|disable|enable|install|kill|migrate|pull|remove|restart|restore|retire|revoke|rotate|run|set|shutdown|start|stop|uninstall|update|upgrade|write/i.test(tool);
  return {
    read_only: !mutating && risk !== "critical",
    mutating,
    external: /web|network|github|jellyfin|proxmox|ansible|vpn|nginx|container/i.test(tool),
    security_sensitive: risk === "high" || risk === "critical" || /secret|credential|auth|research/i.test(tool),
  };
}

function testMatches(identifiers) {
  const needles = identifiers.filter(Boolean).map(value => String(value).toLowerCase());
  // Test fixtures create nested databases and artifacts. Inventory discovery
  // must remain bounded and source-derived, so only inspect test source files.
  const testFiles = fs.readdirSync(testsRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.js"))
    .map(entry => path.join(testsRoot, entry.name));
  return testFiles.filter(file => {
    const content = fs.readFileSync(file, "utf8").toLowerCase();
    const candidate = path.basename(file).replace(/[^a-z0-9]/gi, "").toLowerCase();
    return needles.some(needle => content.includes(needle) || candidate.includes(needle.replace(/[^a-z0-9]/g, "")));
  }).map(relative).sort();
}

function inventoryPack(packDir) {
  const manifestPath = path.join(packDir, "sidekick.pack.json");
  const manifest = readJson(manifestPath);
  const moduleDetails = (manifest.modules || []).map(module => {
    const moduleRoot = path.join(packDir, module.path);
    const moduleManifestPath = path.join(moduleRoot, "manifest.json");
    const moduleManifest = fs.existsSync(moduleManifestPath) ? readJson(moduleManifestPath) : {};
    const permissions = Array.isArray(moduleManifest.permissions) ? moduleManifest.permissions : [];
    const tools = Object.entries(moduleManifest.tools || {}).map(([name, descriptor]) => ({ name, risk: descriptor?.risk || "unknown", category: descriptor?.category || null }));
    return { name: module.name, manifest: relative(moduleManifestPath), dependencies: moduleManifest.dependencies || [], optional_dependencies: moduleManifest.optionalDependencies || [], tools, permissions, operations: [...permissions, ...tools].map(operationClass) };
  });
  const knowledge = (manifest.knowledge || []).map(asset => ({ ...asset, file: relative(path.join(packDir, asset.path)), present: fs.existsSync(path.join(packDir, asset.path)) }));
  const workflows = (manifest.workflows || []).map(workflow => ({ ...workflow, file: relative(path.join(packDir, workflow.path)), present: fs.existsSync(path.join(packDir, workflow.path)) }));
  const workflowDefinitions = workflows.filter(workflow => workflow.present).map(workflow => readJson(path.join(root, workflow.file)));
  const permissions = (manifest.permissions || []).map(operationClass);
  const moduleFiles = manifest.modules.map(module => path.join(packDir, module.path, module.entry_point || "entry.js"));
  const sourceText = moduleFiles.filter(fs.existsSync).map(file => fs.readFileSync(file, "utf8")).join("\n");
  const gaps = ["no stored fixture verification evidence", "no stored canonical-dispatch verification evidence", "no stored cross-pack verification evidence"];
  if (!manifest.configuration) gaps.push("configuration schema is not declared");
  if (!manifest.requires) gaps.push("dependency/tool requirements are not declared");
  if (knowledge.some(asset => !asset.present)) gaps.push("declared knowledge asset is missing");
  if (workflows.some(workflow => !workflow.present)) gaps.push("declared workflow is missing");
  const workflowContract = {
    total: workflowDefinitions.length,
    missing_result: workflowDefinitions.filter(workflow => !workflow.result || typeof workflow.result !== "object").map(workflow => workflow.name),
    missing_tags: workflowDefinitions.filter(workflow => !Array.isArray(workflow.tags) || workflow.tags.length === 0).map(workflow => workflow.name),
    missing_step_error_policy: workflowDefinitions.filter(workflow => (workflow.steps || []).some(step => !["fail", "continue"].includes(step.on_error))).map(workflow => workflow.name),
  };
  if (workflowContract.missing_result.length || workflowContract.missing_tags.length || workflowContract.missing_step_error_policy.length) gaps.push("workflow contract fields require review");
  return {
    name: manifest.name,
    version: manifest.version,
    purpose: manifest.description,
    manifest: relative(manifestPath),
    tools: moduleDetails.flatMap(module => module.tools.map(tool => tool.name)).sort(),
    workflows,
    knowledge,
    configuration: manifest.configuration || null,
    dependencies: manifest.depends || { packs: [] },
    declared_requirements: manifest.requires || { tools: [], optional_tools: [] },
    permissions: manifest.permissions || [],
    network_scopes: [...new Set(moduleDetails.flatMap(module => module.permissions.flatMap(permission => permission.network_scopes || permission.networkScopes || [])))],
    provider_requirements: manifest.provider_requirements || null,
    workflow_contract: workflowContract,
    module_details: moduleDetails,
    operation_classes: [...permissions, ...moduleDetails.flatMap(module => module.tools)].map(operationClass),
    health_readiness: {
      has_health_or_readiness_operation: /health|readiness|capabilit/i.test(sourceText),
      source_files: moduleFiles.filter(file => /health|readiness|capabilit/i.test(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")).map(relative),
      behavior: /unavailable|degraded|not_configured/i.test(sourceText) ? "explicit_unavailable_or_degraded_states" : "not_observed_in_module_source",
    },
    current_tests: testMatches([manifest.name, manifest.display_name, ...manifest.modules.map(module => module.name), ...moduleDetails.flatMap(module => module.tools.map(tool => tool.name))]),
    maturity_gaps: gaps,
    overlaps: [],
    evidence_status: "not_evaluated",
  };
}

const packs = fs.readdirSync(packsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => inventoryPack(path.join(packsRoot, entry.name))).sort((a, b) => a.name.localeCompare(b.name));
for (const pack of packs) {
  pack.overlaps = packs.filter(other => other.name !== pack.name && pack.tools.some(tool => other.tools.includes(tool))).map(other => other.name).sort();
}
const report = { schema: "sidekick.compatibility-pack-inventory.v1", source: "bundled pack manifests and repository files", pack_count: packs.length, packs };
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ ok: true, output: relative(output), pack_count: packs.length, knowledge_assets: packs.reduce((sum, pack) => sum + pack.knowledge.length, 0), workflows: packs.reduce((sum, pack) => sum + pack.workflows.length, 0) }) + "\n");
