"use strict";

/**
 * Capability-pack repository.
 *
 * Owns pack identity, lifecycle state, configuration and COMPONENT OWNERSHIP.
 * It deliberately owns nothing else: module runtime state, workflow execution
 * history, knowledge content and tool logs all remain with their existing
 * authorities. The component rows are the join that lets disable, upgrade and
 * uninstall act coherently across those subsystems.
 */

const crypto = require("crypto");
const dbStore = require("../db");
const { ensureCapabilityPackSchema } = require("./schema");
const { normalizePackManifest, validatePackConfig, PROVENANCE } = require("./manifest");
const { compareVersions } = require("../modules/manifest");

const PACK_STATES = Object.freeze(["installed", "configured", "enabled", "disabled", "error"]);
const COMPONENT_KINDS = Object.freeze(["module", "workflow", "knowledge"]);

function nowIso() {
  return new Date().toISOString();
}

function getDb() {
  return dbStore.getDb();
}

function ensureStorage() {
  ensureCapabilityPackSchema();
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    ...row,
    manifest: parseJson(row.manifest_json, {}),
    config: parseJson(row.config_json, {}),
    health: parseJson(row.health_json, {}),
    source: parseJson(row.source_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function getPack(name) {
  ensureStorage();
  return normalizeRow(getDb().prepare("SELECT * FROM platform_capability_packs WHERE name = ?").get(String(name)));
}

function listPacks({ state } = {}) {
  ensureStorage();
  if (state) {
    if (!PACK_STATES.includes(state)) throw new Error(`Invalid pack state filter: ${state}`);
    return getDb().prepare("SELECT * FROM platform_capability_packs WHERE state = ? ORDER BY name").all(state).map(normalizeRow);
  }
  return getDb().prepare("SELECT * FROM platform_capability_packs ORDER BY name").all().map(normalizeRow);
}

function registerPack(manifestInput, { provenance = "third_party", packageHash, installPath, source = {}, config } = {}) {
  ensureStorage();
  const manifest = normalizePackManifest(manifestInput);
  if (!PROVENANCE.includes(provenance)) throw new Error(`Invalid pack provenance: ${provenance}`);
  if (getPack(manifest.name)) throw new Error(`Capability pack "${manifest.name}" is already installed`);

  const configResult = validatePackConfig(manifest, config);
  if (!configResult.ok) {
    throw new Error(`Capability pack "${manifest.name}" configuration is invalid: ${configResult.errors.map(e => `${e.path}: ${e.message}`).join("; ")}`);
  }

  const packId = `pack_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
  getDb().prepare(`
    INSERT INTO platform_capability_packs (
      pack_id, name, display_name, version, description, publisher, provenance, state,
      manifest_json, config_json, package_hash, install_path, source_json, compatibility,
      installed_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'installed', ?, ?, ?, ?, ?, ?, ?, '{}')
  `).run(
    packId,
    manifest.name,
    manifest.display_name,
    manifest.version,
    manifest.description,
    manifest.publisher,
    provenance,
    JSON.stringify(manifest),
    JSON.stringify(configResult.config),
    packageHash || null,
    installPath || null,
    JSON.stringify(source || {}),
    manifest.compatibility?.sidekick || null,
    nowIso()
  );
  return getPack(manifest.name);
}

function setPackState(name, state, { error = null } = {}) {
  ensureStorage();
  if (!PACK_STATES.includes(state)) throw new Error(`Invalid pack state: ${state}`);
  const record = getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);
  const timestampColumn = { enabled: "enabled_at", disabled: "disabled_at", configured: "configured_at" }[state];
  const sets = ["state = ?"];
  const params = [state];
  if (timestampColumn) {
    sets.push(`${timestampColumn} = ?`);
    params.push(nowIso());
  }
  sets.push("error = ?");
  params.push(state === "error" ? String(error || "unknown pack error") : null);
  getDb().prepare(`UPDATE platform_capability_packs SET ${sets.join(", ")} WHERE pack_id = ?`).run(...params, record.pack_id);
  recordPackEvent(name, "pack.transition", { from: record.state, to: state, error: error ? String(error).slice(0, 300) : undefined });
  return getPack(name);
}

function setPackConfig(name, config) {
  ensureStorage();
  const record = getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);
  const result = validatePackConfig(record.manifest, config);
  if (!result.ok) {
    throw new Error(`Capability pack "${name}" configuration is invalid: ${result.errors.map(e => `${e.path}: ${e.message}`).join("; ")}`);
  }
  getDb()
    .prepare("UPDATE platform_capability_packs SET config_json = ?, configured_at = ? WHERE pack_id = ?")
    .run(JSON.stringify(result.config), nowIso(), record.pack_id);
  return getPack(name);
}

function recordPackHealth(name, health) {
  ensureStorage();
  const record = getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);
  getDb()
    .prepare("UPDATE platform_capability_packs SET health_json = ?, last_health_check_at = ? WHERE pack_id = ?")
    .run(JSON.stringify(health || {}), nowIso(), record.pack_id);
  return getPack(name);
}

function updatePackPackage(name, manifestInput, { packageHash, installPath, source, config, allowSameVersion = false, allowDowngrade = false } = {}) {
  ensureStorage();
  const record = getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);
  const manifest = normalizePackManifest(manifestInput);
  if (manifest.name !== record.name) throw new Error(`Pack upgrade identity mismatch: expected "${record.name}", got "${manifest.name}"`);

  const direction = compareVersions(manifest.version, record.version);
  const sameHash = packageHash && record.package_hash && packageHash === record.package_hash;
  if (direction === 0 && !allowSameVersion) {
    throw new Error(
      sameHash
        ? `Capability pack "${name}" is already at version ${record.version} with an identical package`
        : `Capability pack "${name}" declares the same version ${record.version} with a different package; same-version replacement must be explicit`
    );
  }
  if (direction < 0 && !allowDowngrade) {
    throw new Error(`Capability pack "${name}" upgrade must increase version from ${record.version} to ${manifest.version}`);
  }

  // Configuration survives the upgrade unless the operator supplies new values,
  // and must still validate against the NEW schema.
  const configResult = validatePackConfig(manifest, config === undefined ? record.config : config);
  if (!configResult.ok) {
    throw new Error(`Capability pack "${name}" configuration is not valid for version ${manifest.version}: ${configResult.errors.map(e => `${e.path}: ${e.message}`).join("; ")}`);
  }

  getDb().prepare(`
    UPDATE platform_capability_packs
    SET display_name = ?, version = ?, description = ?, publisher = ?, manifest_json = ?, config_json = ?,
        package_hash = ?, install_path = ?, source_json = ?, compatibility = ?, error = NULL
    WHERE pack_id = ?
  `).run(
    manifest.display_name,
    manifest.version,
    manifest.description,
    manifest.publisher,
    JSON.stringify(manifest),
    JSON.stringify(configResult.config),
    packageHash === undefined ? record.package_hash : packageHash,
    installPath === undefined ? record.install_path : installPath,
    JSON.stringify(source === undefined ? record.source : source),
    manifest.compatibility?.sidekick || null,
    record.pack_id
  );
  return getPack(name);
}

function deletePack(name) {
  ensureStorage();
  const record = getPack(name);
  if (!record) return { removed: false };
  getDb().prepare("DELETE FROM platform_capability_pack_components WHERE pack_name = ?").run(record.name);
  getDb().prepare("DELETE FROM platform_capability_packs WHERE pack_id = ?").run(record.pack_id);
  recordPackEvent(name, "pack.uninstalled", { version: record.version });
  return { removed: true, pack: record };
}

// --- Component ownership -------------------------------------------------

function recordComponent(packName, packVersion, kind, ref, { version = null, state = "installed", detail = {} } = {}) {
  ensureStorage();
  if (!COMPONENT_KINDS.includes(kind)) throw new Error(`Invalid pack component kind: ${kind}`);
  const existing = getComponent(packName, kind, ref);
  const ts = nowIso();
  if (existing) {
    getDb().prepare(`
      UPDATE platform_capability_pack_components
      SET pack_version = ?, version = ?, state = ?, detail_json = ?, updated_at = ?
      WHERE component_id = ?
    `).run(packVersion, version, state, JSON.stringify(detail), ts, existing.component_id);
    return getComponent(packName, kind, ref);
  }
  const componentId = `pcmp_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
  getDb().prepare(`
    INSERT INTO platform_capability_pack_components (
      component_id, pack_name, pack_version, kind, ref, version, state, detail_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(componentId, packName, packVersion, kind, ref, version, state, JSON.stringify(detail), ts, ts);
  return getComponent(packName, kind, ref);
}

function normalizeComponent(row) {
  if (!row) return null;
  return { ...row, detail: parseJson(row.detail_json, {}) };
}

function getComponent(packName, kind, ref) {
  ensureStorage();
  return normalizeComponent(
    getDb()
      .prepare("SELECT * FROM platform_capability_pack_components WHERE pack_name = ? AND kind = ? AND ref = ?")
      .get(String(packName), String(kind), String(ref))
  );
}

function listComponents(packName, { kind } = {}) {
  ensureStorage();
  if (kind) {
    return getDb()
      .prepare("SELECT * FROM platform_capability_pack_components WHERE pack_name = ? AND kind = ? ORDER BY ref")
      .all(String(packName), String(kind))
      .map(normalizeComponent);
  }
  return getDb()
    .prepare("SELECT * FROM platform_capability_pack_components WHERE pack_name = ? ORDER BY kind, ref")
    .all(String(packName))
    .map(normalizeComponent);
}

/** Which pack (if any) owns a given component. Used to refuse double ownership. */
function findComponentOwner(kind, ref) {
  ensureStorage();
  return normalizeComponent(
    getDb().prepare("SELECT * FROM platform_capability_pack_components WHERE kind = ? AND ref = ?").get(String(kind), String(ref))
  );
}

function setComponentState(packName, kind, ref, state) {
  ensureStorage();
  const component = getComponent(packName, kind, ref);
  if (!component) return null;
  getDb()
    .prepare("UPDATE platform_capability_pack_components SET state = ?, updated_at = ? WHERE component_id = ?")
    .run(state, nowIso(), component.component_id);
  return getComponent(packName, kind, ref);
}

function removeComponent(packName, kind, ref) {
  ensureStorage();
  const component = getComponent(packName, kind, ref);
  if (!component) return { removed: false };
  getDb().prepare("DELETE FROM platform_capability_pack_components WHERE component_id = ?").run(component.component_id);
  return { removed: true, component };
}

/**
 * Best-effort kernel ledger event. Never throws: observability must not break
 * a lifecycle operation.
 */
function recordPackEvent(packName, eventType, payload = {}) {
  try {
    require("../platform/kernel").appendEvent({
      event_type: eventType,
      source: "capability-packs",
      subject_type: "capability_pack",
      subject_id: packName,
      severity: payload.error ? "warning" : "info",
      redaction_state: "none",
      payload: { pack: packName, ...payload },
    });
  } catch {}
}

module.exports = {
  PACK_STATES,
  COMPONENT_KINDS,
  ensureStorage,
  getPack,
  listPacks,
  registerPack,
  setPackState,
  setPackConfig,
  recordPackHealth,
  updatePackPackage,
  deletePack,
  recordComponent,
  getComponent,
  listComponents,
  findComponentOwner,
  setComponentState,
  removeComponent,
  recordPackEvent,
};
