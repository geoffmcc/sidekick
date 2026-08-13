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
 *
 * A pack owns components; it does not own their runtime state. Module state
 * stays on platform_modules, workflow execution in the kernel ledger, and
 * knowledge in the knowledge store.
 */

const fs = require("fs");
const Ajv = require("ajv");
const { z } = require("zod");
const { parseVersion, satisfiesVersion } = require("../modules/manifest");

const PACK_MANIFEST_FILENAME = "sidekick.pack.json";
const PACK_SCHEMA_VERSION = 1;
const PACK_NAME_RE = /^[a-z][a-z0-9-]*$/;
const RELATIVE_PATH_RE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;
const PROVENANCE = Object.freeze(["first_party", "third_party"]);

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

const packManifestSchema = z.object({
  schema_version: z.literal(PACK_SCHEMA_VERSION).default(PACK_SCHEMA_VERSION),
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

function parsePackManifestFile(filePath) {
  return normalizePackManifest(JSON.parse(fs.readFileSync(filePath, "utf-8")));
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

module.exports = {
  PACK_MANIFEST_FILENAME,
  PACK_SCHEMA_VERSION,
  PACK_NAME_RE,
  PROVENANCE,
  packManifestSchema,
  normalizePackManifest,
  parsePackManifestFile,
  validatePackConfig,
  checkPackCompatibility,
};
