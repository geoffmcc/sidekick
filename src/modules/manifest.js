"use strict";

/**
 * Module manifest contract (docs/module-system-design.md).
 *
 * A module manifest is pure, serializable data. It declares identity,
 * version, Sidekick compatibility, dependencies, capabilities, configuration
 * schema, permissions, the tools the module provides (with one owner for
 * names, aliases, schemas, handlers, risks and categories), migrations, and
 * lifecycle/disable/uninstall behavior. Function surfaces (health, lifecycle
 * hooks, tool descriptor construction) live on the module entry, never in the
 * manifest.
 *
 * The manifest is validated before activation and stored verbatim in the
 * `platform_modules` table. Duplicate names and aliases fail closed against
 * the live registry using the existing registry rules.
 */

const fs = require("fs");
const Ajv = require("ajv");
const { z } = require("zod");
const { RISK_LEVELS } = require("../tools/metadata");
const { stripSidekickPrefix } = require("../core/tool-name");

const MANIFEST_CONTRACT_VERSION = "1.0.0";

const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const MODULE_TYPES = Object.freeze(["builtin", "plugin"]);
const MODULE_STATES = Object.freeze([
  "discovered",
  "validated",
  "installed",
  "configured",
  "enabled",
  "healthy",
  "disabled",
  "uninstalling",
  "uninstalled",
  "error",
]);

const MODULE_TRANSITIONS = Object.freeze({
  discovered: ["validated", "error"],
  validated: ["installed", "error"],
  installed: ["configured", "enabled", "uninstalling", "error"],
  configured: ["enabled", "installed", "error"],
  enabled: ["healthy", "disabled", "error"],
  healthy: ["disabled", "error"],
  disabled: ["enabled", "installed", "uninstalling", "error"],
  uninstalling: ["uninstalled", "enabled", "error"],
  uninstalled: [],
  error: ["installed", "configured", "disabled", "enabled"],
});

const TOOL_DECLARATION_SCHEMA = z.object({
  risk: z.enum(RISK_LEVELS),
  category: z.string().optional(),
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
});

const PERMISSION_SCHEMA = z.union([
  z.object({ tool: z.string().regex(/^[a-z][a-z0-9_]*$/), risk: z.enum(RISK_LEVELS) }),
  z.object({ capability: z.string().min(1) }),
]);

const MIGRATION_SCHEMA = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  sql: z.string().min(1),
});

const ENTRY_POINT_RE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;

const manifestSchema = z.object({
  name: z.string().regex(MODULE_NAME_RE),
  version: z.string(),
  sidekick: z.string().optional(),
  description: z.string().min(1),
  // Operator-facing label. Identity stays `name`; this only affects display.
  displayName: z.string().min(1).optional().nullable(),
  // Declared entry file, relative to the package root. Traversal and absolute
  // paths are refused here as well as at resolution time (defence in depth:
  // this is the value that decides which file Sidekick will require).
  entryPoint: z.string().regex(ENTRY_POINT_RE).optional().nullable(),
  author: z.string().optional().nullable(),
  type: z.enum(MODULE_TYPES).default("plugin"),
  dependencies: z.array(z.string().regex(MODULE_NAME_RE)).default([]),
  optionalDependencies: z.array(z.string().regex(MODULE_NAME_RE)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  configSchema: z.any().optional().nullable(),
  permissions: z.array(PERMISSION_SCHEMA).default([]),
  tools: z.record(TOOL_DECLARATION_SCHEMA).default({}),
  workflows: z.array(z.string().min(1)).default([]),
  agents: z.array(z.string().min(1)).default([]),
  connectors: z.array(z.string().min(1)).default([]),
  events: z.object({
    publishes: z.array(z.string().min(1)).default([]),
    consumes: z.array(z.string().min(1)).default([]),
  }).default({ publishes: [], consumes: [] }),
  dashboard: z.array(z.string().min(1)).default([]),
  backgroundServices: z.array(z.string().min(1)).default([]),
  migrations: z.array(MIGRATION_SCHEMA).default([]),
  lifecycle: z.object({
    disable: z.enum(["stop_new_work", "drain"]).default("stop_new_work"),
    uninstall: z.enum(["retain_data", "ask"]).default("retain_data"),
  }).default({ disable: "stop_new_work", uninstall: "retain_data" }),
  retention: z.enum(["default", "keep"]).default("default"),
});

const ajv = new Ajv({ allErrors: true });

// --- Semver helpers (minimal, dependency-free) ---

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseVersion(input) {
  if (typeof input !== "string") return null;
  const match = input.trim().match(SEMVER_RE);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
  };
}

function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) throw new Error(`Invalid semver in comparison: "${a}" vs "${b}"`);
  if (av.major !== bv.major) return av.major < bv.major ? -1 : 1;
  if (av.minor !== bv.minor) return av.minor < bv.minor ? -1 : 1;
  if (av.patch !== bv.patch) return av.patch < bv.patch ? -1 : 1;
  if (av.prerelease && !bv.prerelease) return -1;
  if (!av.prerelease && bv.prerelease) return 1;
  if (av.prerelease && bv.prerelease) return av.prerelease < bv.prerelease ? -1 : av.prerelease > bv.prerelease ? 1 : 0;
  return 0;
}

function splitRange(range) {
  return String(range || "").split(/\s*(?:,|\s+)\s*/).filter(Boolean);
}

function satisfiesSingle(version, comparator) {
  const match = comparator.match(/^(>=|<=|>|<|\^|~)?(.*)$/);
  const op = match[1] || "";
  const target = match[2].trim();
  if (!target || target === "*" || target === "x") return true;
  if (!parseVersion(version)) return false;
  if (target.includes("*")) {
    const stars = target.split(".");
    const requested = stars.map(part => (part === "*" || part === "x" ? null : parseInt(part, 10)));
    const parsed = parseVersion(version);
    for (let i = 0; i < requested.length; i++) {
      if (requested[i] === null) return true;
      if (parsed[i < 1 ? "major" : i === 1 ? "minor" : "patch"] !== requested[i]) return false;
    }
    return true;
  }
  if (!parseVersion(target)) return false;
  if (op === "") return compareVersions(version, target) === 0;
  if (op === "^") {
    const t = parseVersion(target);
    const v = parseVersion(version);
    if (t.major > 0) return v.major === t.major && compareVersions(version, target) >= 0;
    if (t.minor > 0) return v.major === t.major && v.minor === t.minor && v.patch >= t.patch;
    return v.major === t.major && v.minor === t.minor && v.patch === t.patch;
  }
  if (op === "~") {
    const t = parseVersion(target);
    const v = parseVersion(version);
    if (v.major !== t.major || v.minor !== t.minor) return false;
    return v.patch >= t.patch;
  }
  const comparison = compareVersions(version, target);
  if (op === ">=") return comparison >= 0;
  if (op === "<=") return comparison <= 0;
  if (op === ">") return comparison > 0;
  if (op === "<") return comparison < 0;
  return false;
}

function satisfiesVersion(version, range) {
  return splitRange(range).every(comparator => satisfiesSingle(version, comparator));
}

// --- Manifest normalization and validation ---

function normalizeManifest(input) {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid module manifest${details ? ": " + details : ""}`);
  }
  if (!parseVersion(parsed.data.version)) {
    throw new Error(`Invalid module version: ${parsed.data.version}`);
  }
  if (parsed.data.sidekick && !/^(>=|<=|>|<|\^|~|[0-9*])/.test(parsed.data.sidekick)) {
    throw new Error(`Invalid sidekick compatibility range: ${parsed.data.sidekick}`);
  }
  if (parsed.data.entryPoint && parsed.data.entryPoint.split("/").includes("..")) {
    throw new Error(`Invalid module entry point: ${parsed.data.entryPoint}`);
  }
  for (const name of Object.keys(parsed.data.tools)) {
    const canonical = stripSidekickPrefix(name);
    if (canonical !== name || !/^[a-z][a-z0-9_]*$/.test(canonical)) {
      throw new Error(`Invalid tool declaration name: ${name}`);
    }
  }
  const duplicateMigrations = parsed.data.migrations.map(m => m.name).filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicateMigrations.length) {
    throw new Error(`Duplicate module migration names: ${duplicateMigrations.join(", ")}`);
  }
  return Object.freeze(parsed.data);
}

function parseManifestFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return normalizeManifest(raw);
}

// --- Config validation ---

function validateModuleConfig(manifest, config) {
  const value = config === undefined || config === null ? {} : config;
  if (!manifest.configSchema) return { ok: true, config: value };
  let validate;
  try {
    validate = ajv.compile(manifest.configSchema);
  } catch (e) {
    return { ok: false, errors: [{ path: "/", message: `Invalid config schema: ${e.message}` }] };
  }
  const valid = validate(value);
  if (!valid) {
    const errors = (validate.errors || []).map(e => ({ path: e.instancePath || "/", message: e.message }));
    return { ok: false, errors };
  }
  return { ok: true, config: value };
}

// --- Ownership checks (fail closed) ---

function checkManifestOwnership(manifest, context = {}) {
  const errors = [];
  const toolNames = new Set(context.toolNames || []);
  const aliases = new Set(context.aliases || []);
  const installedModules = new Set(context.installedModules || []);

  if (installedModules.has(manifest.name)) {
    errors.push(`Module "${manifest.name}" is already installed`);
  }
  for (const name of Object.keys(manifest.tools)) {
    const canonical = stripSidekickPrefix(name);
    if (toolNames.has(canonical)) {
      errors.push(`Module "${manifest.name}" tool "${canonical}" conflicts with an existing registered tool`);
    }
    for (const alias of manifest.tools[name].aliases) {
      const canonicalAlias = stripSidekickPrefix(alias);
      if (toolNames.has(canonicalAlias)) {
        errors.push(`Module "${manifest.name}" tool alias "${canonicalAlias}" conflicts with an existing registered tool`);
      }
      if (aliases.has(canonicalAlias)) {
        errors.push(`Module "${manifest.name}" tool alias "${canonicalAlias}" conflicts with an existing tool alias`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function verifyModuleTools(manifest, descriptors) {
  const errors = [];
  const declared = Object.keys(manifest.tools);
  const provided = descriptors.map(d => stripSidekickPrefix(d.name));
  const providedByName = new Map(descriptors.map(d => [stripSidekickPrefix(d.name), d]));

  for (const name of provided) {
    // Own-property check: an inherited key like "constructor" must not
    // satisfy the declared-tool guard.
    if (!Object.prototype.hasOwnProperty.call(manifest.tools, name)) {
      errors.push(`Module "${manifest.name}" provides undeclared tool "${name}"`);
      continue;
    }
    const descriptor = providedByName.get(name);
    if (descriptor.risk !== manifest.tools[name].risk) {
      errors.push(`Module "${manifest.name}" tool "${name}" risk ${descriptor.risk} does not match declared risk ${manifest.tools[name].risk}`);
    }
    for (const alias of descriptor.aliases || []) {
      if (!(manifest.tools[name].aliases || []).includes(alias)) {
        errors.push(`Module "${manifest.name}" tool "${name}" declares undeclared alias "${alias}"`);
      }
    }
  }
  for (const name of declared) {
    if (!provided.includes(name)) {
      errors.push(`Module "${manifest.name}" declares tool "${name}" but provides no descriptor`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  MANIFEST_CONTRACT_VERSION,
  MODULE_NAME_RE,
  MODULE_STATES,
  MODULE_TRANSITIONS,
  MODULE_TYPES,
  manifestSchema,
  parseVersion,
  compareVersions,
  satisfiesVersion,
  normalizeManifest,
  parseManifestFile,
  validateModuleConfig,
  checkManifestOwnership,
  verifyModuleTools,
};
