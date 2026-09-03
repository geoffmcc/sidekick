"use strict";

// Generates a bounded, source-derived audit matrix. It intentionally reports
// evidence gaps instead of inferring maturity from filenames or manifest shape.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const packsRoot = path.join(root, "packs");
const testsRoot = path.join(root, "test");
const output = path.join(root, "docs", "compatibility-pack-inventory.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sourceFingerprint() {
  const files = walk(packsRoot).filter(file => fs.statSync(file).isFile()).sort();
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(relative(file)).update("\0").update(fs.readFileSync(file)).update("\0");
  return `sha256:${hash.digest("hex")}`;
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

const LIFECYCLE = [
  "discovery", "inventory", "analysis", "diagnosis", "planning",
  "execution", "verification", "recovery", "health", "workflows",
  "composition", "security", "fixtures", "docs", "certification",
];

const LIFECYCLE_RULES = {
  discovery: /discover|recon|profile|enumerat|capabilit/i,
  inventory: /inventor|list_|list\b|catalog|scope/i,
  analysis: /analys|audit|compare|diff|inspect|semantic/i,
  diagnosis: /diagnos|troubleshoot|incident|problem|triage/i,
  planning: /plan|preflight|readiness|prepare|gate/i,
  execution: /execute|apply|create|configure|convert|migrat|provision|restore|run_task|scan_library|update/i,
  verification: /verif|check|assert|validate|test|proof|evidence/i,
  recovery: /recover|rollback|retry|restore|restart|reboot|cleanup|cancel/i,
  health: /health|healthy|status|readiness|availability|degraded/i,
  composition: /compose|depend|requires|optional_tools|proxmox|workflow.*tool/i,
  security: /security|safe|safety|permission|credential|secret|scope|policy|auth|tls|least.?privilege/i,
};

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function inferredUsers(text) {
  const roles = [
    ["developer", /developer|software|repository|code|release|ci/i],
    ["operator", /operat|infrastructure|service|container|network|system|host/i],
    ["administrator", /administrat|database|proxmox|jellyfin|storage/i],
    ["security researcher", /security.?research|research|campaign|hypothes|probe/i],
    ["quality engineer", /test|quality|verification|skeptical/i],
  ];
  const matches = roles.filter(([, pattern]) => pattern.test(text)).map(([role]) => role);
  return matches.length ? matches : ["Sidekick operators"];
}

function workflowJob(workflow) {
  return workflow.title || workflow.name || workflow.path.replace(/\.json$/, "").split("/").pop().replace(/[-_]+/g, " ");
}

function capabilityMatrix({ manifest, files, workflows, tools, gaps }) {
  const descriptorText = JSON.stringify(manifest);
  const sourceFiles = files.filter(file => file.kind === "source");
  const workflowFiles = files.filter(file => file.kind === "workflow");
  const testFiles = files.filter(file => file.kind === "test");
  const implementationText = [...sourceFiles, ...workflowFiles].map(file => file.content).join("\n");
  const evidence = {};
  for (const area of LIFECYCLE) {
    let paths = [];
    let observed = false;
    if (area === "workflows") {
      observed = workflows.some(workflow => workflow.present);
      paths = workflowFiles.map(file => file.path);
    } else if (area === "fixtures") {
      observed = testFiles.some(file => /fixture|mock|stub|fake|sample|tempdir|tmpdir/i.test(file.content));
      paths = testFiles.filter(file => /fixture|mock|stub|fake|sample|tempdir|tmpdir/i.test(file.content)).map(file => file.path);
    } else if (area === "docs") {
      observed = manifest.knowledge?.some(asset => asset.present) === true;
      paths = files.filter(file => file.kind === "docs").map(file => file.path);
    } else if (area === "certification") {
      observed = false;
    } else {
      const descriptorEvidence = area === "composition" || area === "security";
      const candidates = descriptorEvidence
        ? [{ path: manifest.manifest, content: descriptorText }, ...files]
        : files;
      paths = candidates.filter(file => LIFECYCLE_RULES[area].test(file.content)).map(file => file.path);
      observed = paths.length > 0 && (descriptorEvidence || LIFECYCLE_RULES[area].test(implementationText));
    }
    evidence[area] = {
      status: area === "certification" ? "not_evaluated" : observed ? "observed" : "not_observed",
      implemented: observed,
      evidence: unique(paths),
    };
  }
  const weaknesses = unique([
    ...gaps,
    ...LIFECYCLE.filter(area => !evidence[area].implemented && area !== "certification").map(area => `no observed ${area} implementation evidence`),
  ]);
  const selectedImprovements = LIFECYCLE.filter(area => !evidence[area].implemented && area !== "certification")
    .slice(0, 5).map(area => `add attributable ${area} coverage or evidence`);
  const deferredItems = [
    { item: "certification", reason: "Certification requires server-validated, current evidence; repository descriptors and tests cannot confer it." },
    ...LIFECYCLE.filter(area => !evidence[area].implemented && area !== "certification" && !selectedImprovements.some(item => item.includes(` ${area} `)))
      .map(area => ({ item: area, reason: "No implementation evidence was found in the discovered descriptor, workflow, source, or test files." })),
  ];
  return {
    intended_users: inferredUsers(`${manifest.display_name || ""} ${manifest.description || ""} ${descriptorText}`),
    jobs: unique([...workflows.filter(workflow => workflow.present).map(workflowJob), ...tools]),
    lifecycle_coverage: evidence,
    current_implementation_coverage: {
      covered: LIFECYCLE.filter(area => evidence[area].implemented),
      uncovered: LIFECYCLE.filter(area => !evidence[area].implemented),
      evidence_sources: unique(files.map(file => file.path)),
    },
    weaknesses,
    selected_improvements: selectedImprovements,
    deferred_items: deferredItems,
    evidence_status: "not_evaluated",
  };
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
  const descriptorEvidence = moduleDetails.map(module => ({ kind: "descriptor", path: module.manifest, content: fs.readFileSync(path.join(root, module.manifest), "utf8") }));
  const sourceEvidence = moduleFiles.filter(fs.existsSync).map(file => ({ kind: "source", path: relative(file), content: fs.readFileSync(file, "utf8") }));
  const workflowEvidence = workflows.filter(workflow => workflow.present).map(workflow => ({ kind: "workflow", path: workflow.file, content: fs.readFileSync(path.join(root, workflow.file), "utf8") }));
  const testEvidence = testMatches([manifest.name, manifest.display_name, ...manifest.modules.map(module => module.name), ...moduleDetails.flatMap(module => module.tools.map(tool => tool.name))]).map(file => ({ kind: "test", path: file, content: fs.readFileSync(path.join(root, file), "utf8") }));
  const docsEvidence = knowledge.filter(asset => asset.present).map(asset => ({ kind: "docs", path: asset.file, content: fs.readFileSync(path.join(root, asset.file), "utf8") }));
  const matrixEvidence = [...descriptorEvidence, ...sourceEvidence, ...workflowEvidence, ...testEvidence, ...docsEvidence];
  const sourceText = sourceEvidence.map(file => file.content).join("\n");
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
    capability_matrix: capabilityMatrix({ manifest: { ...manifest, manifest: relative(manifestPath), knowledge }, files: matrixEvidence, workflows, tools: moduleDetails.flatMap(module => module.tools.map(tool => tool.name)), gaps }),
    evidence_status: "not_evaluated",
  };
}

const manifestPaths = walk(packsRoot).filter(file => path.basename(file) === "sidekick.pack.json");
const packs = manifestPaths.map(file => inventoryPack(path.dirname(file))).sort((a, b) => a.name.localeCompare(b.name));
for (const pack of packs) {
  pack.overlaps = packs.filter(other => other.name !== pack.name && pack.tools.some(tool => other.tools.includes(tool))).map(other => other.name).sort();
}
let source_commit = "working-tree";
let source_commit_date = null;
try {
  source_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  source_commit_date = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {}
const report = { schema: "sidekick.compatibility-pack-inventory.v1", source: "bundled pack manifests and repository files", source_commit, source_commit_date, source_fingerprint: sourceFingerprint(), pack_count: packs.length, packs };
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ ok: true, output: relative(output), pack_count: packs.length, knowledge_assets: packs.reduce((sum, pack) => sum + pack.knowledge.length, 0), workflows: packs.reduce((sum, pack) => sum + pack.workflows.length, 0) }) + "\n");
