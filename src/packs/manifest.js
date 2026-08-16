"use strict";

/**
 * Capability-pack manifest contract (docs/capability-packs.md).
 *
 * A capability pack is an installable AREA OF COMPETENCE. Its manifest is pure
 * data describing identity, compatibility, and the components the pack owns.
 * Every field below has runtime meaning — there are no decorative sections:
 *
 *   modules[]        installed through the module subsystem (B9 lifecycle)
 *   workflows[]      registered in the workflow definition registry
 *   knowledge[]      installed into the knowledge store
 *   requires.tools   verified present at install; a missing one blocks install
 *   requires.optional_tools  reported by health as available/unavailable
 *   configuration    validated pack configuration, handed to owned modules
 *                    that declare `config_from_pack`
 *   pack_api         formal platform contract version (checkPackApi)
 *   permissions      pack-level statement of every module tool grant; must
 *                    agree exactly with the module aggregate (inspection)
 *   depends.packs    required/optional pack dependencies, resolved and
 *                    cycle-checked before install (src/packs/dependencies.js)
 *
 * A pack owns components; it does not own their runtime state. Module state
 * stays on platform_modules, workflow execution in the kernel ledger, and
 * knowledge in the knowledge store.
 */

const fs = require("fs");
const Ajv = require("ajv");
const { z } = require("zod");
const { parseVersion, satisfiesVersion } = require("../modules/manifest");
const { RISK_LEVELS } = require("../tools/metadata");

const PACK_MANIFEST_FILENAME = "sidekick.pack.json";
const PACK_SCHEMA_VERSION = 1;
// The formal Pack API contract version. Distinct from schema_version (the
// manifest's SHAPE) and compatibility.sidekick (the APPLICATION version):
// pack_api names the platform contract a pack was written against — the
// services facade, lifecycle semantics, permission and dependency model.
// A manifest that omits it is a v1 pack; an unsupported value is refused at
// inspection, before any code is copied or executed.
const PACK_API_VERSIONS = Object.freeze([1]);
const PACK_NAME_RE = /^[a-z][a-z0-9-]*$/;
const RELATIVE_PATH_RE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;
const PROVENANCE = Object.freeze(["first_party", "third_party"]);
// The manifest is parsed before the package walk, so it gets its own bound;
// hashFiles' 64 MiB package cap applies only after a successful parse.
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Full-grammar validation of a semver range: every comparator must be a
 * wildcard or an operator over a parseable version. satisfiesVersion treats an
 * unparseable comparator as never-matching (fail closed), so this check exists
 * for honesty at declaration time — and to keep attacker-shaped strings out of
 * error messages, health details and describe output.
 */
function isValidVersionRange(range) {
  const comparators = String(range || "").split(/\s*(?:,|\s+)\s*/).filter(Boolean);
  if (!comparators.length) return false;
  return comparators.every(comparator => {
    const match = comparator.match(/^(>=|<=|>|<|\^|~)?(.*)$/);
    const target = match[2].trim();
    if (target === "*" || target === "x") return !match[1];
    if (/^[0-9]+(\.([0-9]+|\*|x)){0,2}$/.test(target)) return true;
    return Boolean(parseVersion(target));
  });
}

const relativePath = z.string().regex(RELATIVE_PATH_RE).refine(
  value => !value.split("/").includes("..") && !value.startsWith("/"),
  { message: "must be a relative path inside the pack, without '..' segments" }
);

const MODULE_REF = z.object({
  name: z.string().regex(PACK_NAME_RE),
  path: relativePath,
  entry_point: relativePath.optional(),
  // When true, the pack's validated configuration is what this module is
  // configured with. This is the ONLY configuration coupling between a pack
  // and its modules, and it is explicit in the manifest.
  config_from_pack: z.boolean().default(false),
});

const WORKFLOW_REF = z.object({
  path: relativePath,
});

const KNOWLEDGE_REF = z.object({
  path: relativePath,
  title: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string()).default([]),
});

// Pack-level permission declarations use the same vocabulary as module
// manifests: the pack states, in one reviewable place, every cross-tool grant
// its modules hold. Inspection refuses a pack whose declaration disagrees with
// the aggregate of its modules — the declaration is enforced by construction,
// because the module-level allowlist (src/modules/services.js) is what
// actually gates dispatch.
const PACK_PERMISSION_SCHEMA = z.union([
  z.object({ tool: z.string().regex(/^[a-z][a-z0-9_]*$/), risk: z.enum(RISK_LEVELS) }),
  z.object({ capability: z.string().min(1) }),
]);

const SERVICE_CAPABILITIES = Object.freeze({
  secrets: ["metadata", "use", "write"],
  storage: ["read", "write", "delete"],
});

const SERVICE_SCHEMA = z.object({
  secrets: z.array(z.enum(SERVICE_CAPABILITIES.secrets)).default([]),
  storage: z.array(z.enum(SERVICE_CAPABILITIES.storage)).default([]),
}).default({ secrets: [], storage: [] });

const PACK_DEPENDENCY_SCHEMA = z.object({
  name: z.string().regex(PACK_NAME_RE),
  // Optional semver range the installed dependency must satisfy. Full grammar
  // is validated in normalizePackManifest; the length cap bounds what can be
  // echoed into problems/errors.
  version: z.string().max(64).optional(),
  // An optional dependency never blocks install/enable; it is reported by
  // health and describe so degraded composition is visible, not silent.
  optional: z.boolean().default(false),
});

const packManifestSchema = z.object({
  schema_version: z.literal(PACK_SCHEMA_VERSION).default(PACK_SCHEMA_VERSION),
  // Validated leniently here (any positive integer parses) so inspection and
  // `capability validate` can report "unsupported pack_api 3" as a structured
  // problem instead of a parse failure. checkPackApi is the authority.
  pack_api: z.number().int().positive().default(1),
  name: z.string().regex(PACK_NAME_RE),
  display_name: z.string().min(1),
  version: z.string(),
  description: z.string().min(1),
  publisher: z.string().min(1),
  compatibility: z.object({ sidekick: z.string().optional() }).default({}),
  modules: z.array(MODULE_REF).default([]),
  workflows: z.array(WORKFLOW_REF).default([]),
  knowledge: z.array(KNOWLEDGE_REF).default([]),
  requires: z.object({
    tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    optional_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
  }).default({ tools: [], optional_tools: [] }),
  // Deliberately optional WITHOUT a default: a manifest that omits permissions
  // is a pre-contract pack (accepted, reported as "undeclared"); a manifest
  // that declares them — even as [] — is held to exact agreement with its
  // modules. The distinction is what makes backward compatibility honest.
  permissions: z.array(PACK_PERMISSION_SCHEMA).optional(),
  services: SERVICE_SCHEMA,
  depends: z.object({
    packs: z.array(PACK_DEPENDENCY_SCHEMA).default([]),
  }).default({ packs: [] }),
  configuration: z.object({
    schema: z.any().optional().nullable(),
    defaults: z.record(z.any()).default({}),
  }).default({ schema: null, defaults: {} }),
});

const ajv = new Ajv({ allErrors: true, useDefaults: false });

function normalizePackManifest(input) {
  const parsed = packManifestSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid capability pack manifest${details ? ": " + details : ""}`);
  }
  const manifest = parsed.data;
  const servicePermissions = [
    ...manifest.services.secrets.map(name => ({ capability: `pack.secrets.${name}` })),
    ...manifest.services.storage.map(name => ({ capability: `pack.storage.${name}` })),
  ];
  if (manifest.permissions !== undefined || servicePermissions.length) {
    const declaredPermissionKeys = new Set((manifest.permissions || []).map(permissionKey));
    manifest.permissions = [...(manifest.permissions || []), ...servicePermissions.filter(permission => {
      const key = permissionKey(permission);
      if (declaredPermissionKeys.has(key)) return false;
      declaredPermissionKeys.add(key);
      return true;
    })];
  }
  if (!parseVersion(manifest.version)) throw new Error(`Invalid capability pack version: ${manifest.version}`);

  const moduleNames = new Set();
  for (const module of manifest.modules) {
    if (moduleNames.has(module.name)) throw new Error(`Capability pack "${manifest.name}" declares module "${module.name}" twice`);
    moduleNames.add(module.name);
  }
  const workflowPaths = new Set();
  for (const workflow of manifest.workflows) {
    if (workflowPaths.has(workflow.path)) throw new Error(`Capability pack "${manifest.name}" declares workflow "${workflow.path}" twice`);
    workflowPaths.add(workflow.path);
  }
  const knowledgeTitles = new Set();
  for (const asset of manifest.knowledge) {
    const key = `${asset.category}::${asset.title}`;
    if (knowledgeTitles.has(key)) throw new Error(`Capability pack "${manifest.name}" declares knowledge "${asset.title}" twice`);
    knowledgeTitles.add(key);
  }
  if (manifest.permissions) {
    const permissionKeys = new Set();
    for (const permission of manifest.permissions) {
      const key = permissionKey(permission);
      if (permissionKeys.has(key)) throw new Error(`Capability pack "${manifest.name}" declares permission ${key} twice`);
      permissionKeys.add(key);
    }
  }
  const dependencyNames = new Set();
  for (const dependency of manifest.depends.packs) {
    if (dependency.name === manifest.name) {
      throw new Error(`Capability pack "${manifest.name}" cannot depend on itself`);
    }
    if (dependencyNames.has(dependency.name)) {
      throw new Error(`Capability pack "${manifest.name}" declares dependency "${dependency.name}" twice`);
    }
    dependencyNames.add(dependency.name);
    if (dependency.version !== undefined && !isValidVersionRange(dependency.version)) {
      throw new Error(`Capability pack "${manifest.name}" dependency "${dependency.name}" has an invalid version range`);
    }
  }
  if (manifest.configuration.schema) {
    try {
      ajv.compile(manifest.configuration.schema);
    } catch (error) {
      throw new Error(`Capability pack "${manifest.name}" configuration schema is invalid: ${error.message}`);
    }
  }
  const packConfiguredModules = manifest.modules.filter(module => module.config_from_pack);
  if (packConfiguredModules.length && !manifest.configuration.schema) {
    throw new Error(
      `Capability pack "${manifest.name}" declares config_from_pack modules but no configuration schema`
    );
  }
  return Object.freeze(manifest);
}

/**
 * Guarded manifest read: refuses a symlinked manifest (every other pack asset
 * already goes through a symlink-refusing resolver; the manifest must not be
 * the one exception), bounds the read, and sanitizes JSON parse errors —
 * Node's JSON.parse message embeds a snippet of the parsed text, which for a
 * symlinked or binary file would echo target-file content to the operator.
 */
function readPackManifestFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`${PACK_MANIFEST_FILENAME} is a symlink`);
  if (!stat.isFile()) throw new Error(`${PACK_MANIFEST_FILENAME} is not a regular file`);
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error(`${PACK_MANIFEST_FILENAME} exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(String(error && error.message || ""));
    throw new Error(`${PACK_MANIFEST_FILENAME} is not valid JSON${position ? ` (${position[0]})` : ""}`);
  }
}

function parsePackManifestFile(filePath) {
  return normalizePackManifest(readPackManifestFile(filePath));
}

/** Validate pack configuration against the manifest's schema, applying defaults. */
function validatePackConfig(manifest, config) {
  const merged = { ...(manifest.configuration.defaults || {}), ...(config && typeof config === "object" ? config : {}) };
  if (!manifest.configuration.schema) return { ok: true, config: merged };
  let validate;
  try {
    validate = ajv.compile(manifest.configuration.schema);
  } catch (error) {
    return { ok: false, errors: [{ path: "/", message: `Invalid configuration schema: ${error.message}` }] };
  }
  if (!validate(merged)) {
    return { ok: false, errors: (validate.errors || []).map(e => ({ path: e.instancePath || "/", message: e.message })) };
  }
  return { ok: true, config: merged };
}

function checkPackCompatibility(manifest, sidekickVersion) {
  const requires = manifest.compatibility?.sidekick || null;
  if (!requires) return { ok: true, requires: null, sidekick_version: sidekickVersion };
  return { ok: satisfiesVersion(sidekickVersion, requires), requires, sidekick_version: sidekickVersion };
}

/** Is the manifest's declared Pack API contract one this Sidekick implements? */
function checkPackApi(manifest) {
  const declared = manifest.pack_api ?? 1;
  return {
    ok: PACK_API_VERSIONS.includes(declared),
    pack_api: declared,
    supported: [...PACK_API_VERSIONS],
  };
}

/** Stable identity key for one permission entry, for dedupe and comparison. */
function permissionKey(permission) {
  if (permission && typeof permission.tool === "string") return `tool:${permission.tool}@${permission.risk}`;
  if (permission && typeof permission.capability === "string") return `capability:${permission.capability}`;
  return `invalid:${JSON.stringify(permission)}`;
}

/**
 * The permission set a pack's modules actually hold: the deduplicated union of
 * every owned module manifest's `permissions`, sorted for stable comparison.
 */
function aggregateModulePermissions(moduleManifests) {
  const byKey = new Map();
  for (const manifest of moduleManifests) {
    for (const permission of manifest?.permissions || []) {
      byKey.set(permissionKey(permission), permission);
    }
  }
  return [...byKey.keys()].sort().map(key => byKey.get(key));
}

/**
 * Compare a pack's DECLARED permissions against the aggregate its modules
 * hold. Exact set agreement is required in both directions: an undeclared
 * module grant would hide real access from review, and a declared-but-unheld
 * grant would overstate it.
 */
function comparePackPermissions(declared, moduleManifests) {
  const aggregate = aggregateModulePermissions(moduleManifests);
  const declaredKeys = new Set((declared || []).map(permissionKey));
  const aggregateKeys = new Set(aggregate.map(permissionKey));
  const missing = [...aggregateKeys].filter(key => !declaredKeys.has(key)).sort();
  const extra = [...declaredKeys].filter(key => !aggregateKeys.has(key)).sort();
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, aggregate };
}

module.exports = {
  PACK_MANIFEST_FILENAME,
  PACK_SCHEMA_VERSION,
  PACK_API_VERSIONS,
  PACK_NAME_RE,
  PROVENANCE,
  packManifestSchema,
  normalizePackManifest,
  parsePackManifestFile,
  readPackManifestFile,
  isValidVersionRange,
  validatePackConfig,
  checkPackCompatibility,
  checkPackApi,
  permissionKey,
  aggregateModulePermissions,
  comparePackPermissions,
};
