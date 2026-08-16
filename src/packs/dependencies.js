"use strict";

/**
 * Capability-pack dependency resolution.
 *
 * Dependencies are declared in the pack manifest (`depends.packs`) and
 * resolved against the installed pack set. The rules are deliberately small
 * and deterministic:
 *
 *   - a REQUIRED dependency must be installed (and satisfy its version range)
 *     before the dependent installs, and be enabled before the dependent
 *     enables;
 *   - an OPTIONAL dependency never blocks anything — it is resolved and
 *     reported so degraded composition is visible;
 *   - required edges must be acyclic across the installed set plus the
 *     candidate; a cycle is refused at inspection, before anything is copied;
 *   - a pack with installed required dependents cannot be uninstalled, and one
 *     with ENABLED required dependents cannot be disabled;
 *   - an upgrade must keep every installed dependent's version range
 *     satisfied, or be refused with the dependents named.
 *
 * This module owns no storage. It reads through the pack repository (or an
 * injected view of it, for inspection of not-yet-installed candidates).
 */

const { satisfiesVersion } = require("../modules/manifest");

function repositoryView(overrides = {}) {
  const repository = require("./repository");
  return {
    getPack: overrides.getPack || (name => repository.getPack(name)),
    listPacks: overrides.listPacks || (() => repository.listPacks()),
  };
}

function declaredDependencies(manifest) {
  return manifest?.depends?.packs || [];
}

/**
 * Resolve one manifest's declared dependencies against the installed set.
 * Every declaration gets a row; `problems` collects only the failures that
 * must block (missing/unsatisfied REQUIRED dependencies).
 */
function resolveDependencies(manifest, options = {}) {
  const view = repositoryView(options);
  const resolutions = [];
  const problems = [];
  for (const dependency of declaredDependencies(manifest)) {
    const installed = view.getPack(dependency.name);
    const resolution = {
      name: dependency.name,
      optional: dependency.optional === true,
      requires_version: dependency.version || null,
      installed: Boolean(installed),
      installed_version: installed ? installed.version : null,
      state: installed ? installed.state : null,
      satisfied: false,
      problem: null,
    };
    if (!installed) {
      resolution.problem = `pack "${dependency.name}" is not installed`;
    } else if (dependency.version && !satisfiesVersion(installed.version, dependency.version)) {
      resolution.problem = `pack "${dependency.name}" is ${installed.version} but ${dependency.version} is required`;
    } else {
      resolution.satisfied = true;
    }
    if (resolution.problem && !resolution.optional) {
      problems.push(`required dependency ${resolution.problem}`);
    }
    resolutions.push(resolution);
  }
  return { resolutions, problems, ok: problems.length === 0 };
}

/**
 * Detect a required-dependency cycle in the graph formed by the installed
 * packs plus (or as replaced by) the candidate manifest. Returns the cycle as
 * an ordered name path, or null.
 */
function findDependencyCycle(candidateManifest, options = {}) {
  const view = repositoryView(options);
  const graph = new Map();
  for (const pack of view.listPacks()) {
    if (candidateManifest && pack.name === candidateManifest.name) continue;
    graph.set(pack.name, requiredEdges(pack.manifest));
  }
  if (candidateManifest) graph.set(candidateManifest.name, requiredEdges(candidateManifest));

  const visiting = new Set();
  const done = new Set();
  const path = [];
  const walk = name => {
    if (done.has(name)) return null;
    if (visiting.has(name)) return [...path.slice(path.indexOf(name)), name];
    if (!graph.has(name)) return null; // absent packs are a resolution problem, not a cycle
    visiting.add(name);
    path.push(name);
    for (const edge of graph.get(name)) {
      const cycle = walk(edge);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(name);
    done.add(name);
    return null;
  };
  for (const name of graph.keys()) {
    const cycle = walk(name);
    if (cycle) return cycle;
  }
  return null;
}

function requiredEdges(manifest) {
  return declaredDependencies(manifest)
    .filter(dependency => dependency.optional !== true)
    .map(dependency => dependency.name);
}

/**
 * Installed packs that declare a REQUIRED dependency on `name`.
 * `enabledOnly` restricts to dependents whose capabilities are currently live
 * (the disable guard); uninstall guards against dependents in any state.
 */
function listRequiredDependents(name, { enabledOnly = false, ...overrides } = {}) {
  const view = repositoryView(overrides);
  return view.listPacks().filter(pack => {
    if (pack.name === name) return false;
    if (enabledOnly && pack.state !== "enabled") return false;
    return requiredEdges(pack.manifest).includes(name);
  });
}

/**
 * Would upgrading `name` to `nextVersion` break any installed dependent's
 * declared range? Optional dependents are reported but never block.
 */
function checkDependentConstraints(name, nextVersion, overrides = {}) {
  const view = repositoryView(overrides);
  const broken = [];
  const warnings = [];
  for (const pack of view.listPacks()) {
    if (pack.name === name) continue;
    for (const dependency of declaredDependencies(pack.manifest)) {
      if (dependency.name !== name || !dependency.version) continue;
      if (satisfiesVersion(nextVersion, dependency.version)) continue;
      const detail = `pack "${pack.name}" requires ${name} ${dependency.version}, incompatible with ${nextVersion}`;
      if (dependency.optional === true) warnings.push(detail);
      else broken.push(detail);
    }
  }
  return { ok: broken.length === 0, broken, warnings };
}

module.exports = {
  declaredDependencies,
  resolveDependencies,
  findDependencyCycle,
  listRequiredDependents,
  checkDependentConstraints,
};
