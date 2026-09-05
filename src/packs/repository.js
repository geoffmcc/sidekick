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

// Legal lifecycle transitions, mirroring the module subsystem's discipline
// (src/modules/manifest.js MODULE_TRANSITIONS): every persisted state change is
// validated against this table, same-state writes are permitted (idempotent
// re-enable after a restart is normal), and anything else fails instead of
// silently rewriting history. `error` is recoverable toward any operational
// state; nothing returns to `installed` — that is the registration state only.
const PACK_TRANSITIONS = Object.freeze({
  installed: Object.freeze(["configured", "enabled", "disabled", "error"]),
  configured: Object.freeze(["enabled", "disabled", "error"]),
  enabled: Object.freeze(["disabled", "error"]),
  disabled: Object.freeze(["enabled", "error"]),
  error: Object.freeze(["configured", "enabled", "disabled"]),
});

const COMPONENT_KINDS = Object.freeze(["module", "workflow", "knowledge"]);

function assertPackTransition(from, to) {
  if (from === to) return;
  const allowed = Object.prototype.hasOwnProperty.call(PACK_TRANSITIONS, from) ? PACK_TRANSITIONS[from] : [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid capability pack state transition: ${from} -> ${to}`);
  }
}

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

function normalizeVerification(row) {
  if (!row) return null;
  return {
    ...row,
    evidence_refs: parseJson(row.evidence_json, {}).refs || [],
    checks: parseJson(row.evidence_json, {}).checks || {},
    provider: parseJson(row.provider_json, {}),
    source: row.actor_ref,
    legacy: Boolean(row.legacy),
  };
}

function getPack(name) {
  ensureStorage();
  const pack = normalizeRow(getDb().prepare("SELECT * FROM platform_capability_packs WHERE name = ?").get(String(name)));
  if (pack) pack.verified_evidence = listVerifiedEvidence(pack.name);
  return pack;
}

function listVerifiedEvidence(name) {
  ensureStorage();
  try {
    return getDb().prepare("SELECT * FROM platform_pack_verification_evidence WHERE pack_name = ? AND legacy = 0 ORDER BY observed_at DESC LIMIT 32").all(String(name)).map(normalizeVerification);
  } catch (error) {
    if (/no such table/i.test(String(error.message))) return [];
    throw error;
  }
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
  assertPackTransition(record.state, state);
  const timestampColumn = { enabled: "enabled_at", disabled: "disabled_at", configured: "configured_at" }[state];
  const sets = ["state = ?"];
  const params = [state];
  if (timestampColumn) {
    sets.push(`${timestampColumn} = ?`);
    params.push(nowIso());
  }
  sets.push("error = ?");
  params.push(state === "error" ? String(error || "unknown pack error") : null);
  const metadata = { ...(record.metadata || {}), maturity_lifecycle_epoch: Number(record.metadata?.maturity_lifecycle_epoch || 0) + 1 };
  sets.push("metadata_json = ?");
  params.push(JSON.stringify(metadata));
  // The observed state is part of the WHERE clause: if another process moved
  // the pack between our read and this write, the transition we validated is
  // not the transition we would be performing — fail instead of clobbering.
  const outcome = getDb()
    .prepare(`UPDATE platform_capability_packs SET ${sets.join(", ")} WHERE pack_id = ? AND state = ?`)
    .run(...params, record.pack_id, record.state);
  if (outcome.changes === 0) {
    const current = getPack(name);
    throw new Error(
      `Capability pack "${name}" state changed concurrently (expected ${record.state}, found ${current ? current.state : "missing"})`
    );
  }
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

function recordPackVerification(name, verification) {
  ensureStorage();
  const record = getPack(name);
  if (!record) throw new Error(`Capability pack "${name}" is not installed`);
  if (!verification || typeof verification !== "object" || !Array.isArray(verification.evidence_refs) || verification.evidence_refs.length === 0) {
    const error = new Error("pack verification requires server-verifiable evidence_refs; Boolean checks are not accepted");
    error.code = "invalid_pack_verification";
    throw error;
  }
  if (verification.evidence_refs.length > 32) {
    const error = new Error("pack verification evidence_refs exceeds the bound");
    error.code = "invalid_pack_verification";
    throw error;
  }
  if (typeof verification.actor_ref !== "string" || !verification.actor_ref.trim()) {
    const error = new Error("pack verification requires an attributed actor_ref");
    error.code = "verification_source_required";
    throw error;
  }
  const verified = verifyEvidenceReferences(record, verification.evidence_refs);
  if (!verified.ok) {
    const error = new Error(`pack verification evidence rejected: ${verified.reasons.join("; ")}`);
    error.code = "verification_evidence_rejected";
    throw error;
  }
  const crypto = require("crypto");
  const observedAt = verification.observed_at || nowIso();
  const expiresAt = verification.expires_at || new Date(Date.parse(observedAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const evidence = verified.refs;
  const checks = verified.checks;
  const resultDigest = verification.result_digest || crypto.createHash("sha256").update(JSON.stringify({ evidence, checks, observed_at: observedAt, expires_at: expiresAt })).digest("hex");
  const id = verification.id || `pack-verification-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  getDb().prepare(`INSERT INTO platform_pack_verification_evidence
    (verification_id, pack_name, pack_version, package_hash, config_fingerprint, lifecycle_epoch,
     health_fingerprint, recipe_version, evidence_json, result_digest, actor_ref, project_ref,
     scope_revision, provider_json, status, observed_at, expires_at, legacy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, 0, ?)`)
    .run(id, record.name, record.version, record.package_hash || null, verified.config_fingerprint,
      Number(record.metadata?.maturity_lifecycle_epoch || 0), verified.health_fingerprint,
      String(verification.recipe_version || "pack-proving-v1").slice(0, 64), JSON.stringify({ refs: evidence, checks }),
      resultDigest, verification.actor_ref.slice(0, 256), verification.project_ref ? String(verification.project_ref).slice(0, 256) : null,
      verification.scope_revision ? String(verification.scope_revision).slice(0, 256) : null,
      JSON.stringify(verification.provider || {}), observedAt, expiresAt, nowIso());
  recordPackEvent(name, "pack.verification_recorded", { verification_id: id, evidence_count: evidence.length, recipe_version: verification.recipe_version || "pack-proving-v1" });
  return getPack(name);
}

function verifyEvidenceReferences(record, references) {
  const db = getDb();
  const allowedTools = new Set();
  for (const component of listComponents(record.name, { kind: "module" })) {
    for (const tool of component.detail?.tools || []) allowedTools.add(String(tool).replace(/^sidekick_/, ""));
  }
  const refs = [];
  const reasons = [];
  const usedEvidence = new Map();
  for (const reference of references) {
    if (!reference || typeof reference !== "object" || !["receipt", "workflow", "execution"].includes(reference.type) || typeof reference.id !== "string" || reference.id.length > 256 || !["canonical_dispatch", "agent_discovery", "workflow", "single_pack", "cross_pack", "skeptical_verification", "provider_integration"].includes(reference.role)) {
      reasons.push("malformed evidence reference");
      continue;
    }
    const evidenceKey = `${reference.type}:${reference.id}`;
    const previousRole = usedEvidence.get(evidenceKey);
    if (previousRole && previousRole !== reference.role) {
      reasons.push(`${evidenceKey} cannot support multiple verification roles (${previousRole}, ${reference.role})`);
      continue;
    }
    usedEvidence.set(evidenceKey, reference.role);
    if (reference.type === "receipt") {
      const row = db.prepare("SELECT receipt_id, task_id, capability, capability_version, dispatch_state, outcome_state, project_ref, principal_ref, updated_at FROM agent_operation_receipts WHERE receipt_id = ?").get(reference.id);
      if (!row) { reasons.push(`receipt ${reference.id} does not exist`); continue; }
      if (!["finalized", "verified"].includes(row.outcome_state)) { reasons.push(`receipt ${reference.id} is not terminal`); continue; }
      if (!allowedTools.has(String(row.capability).replace(/^sidekick_/, ""))) { reasons.push(`receipt ${reference.id} used a tool outside pack ownership`); continue; }
      refs.push({ type: "receipt", id: row.receipt_id, role: reference.role, task_id: row.task_id, capability: row.capability, capability_version: row.capability_version, project_ref: row.project_ref, principal_ref: row.principal_ref, observed_at: row.updated_at });
    } else if (reference.type === "workflow") {
      const row = db.prepare("SELECT name, state, updated_at FROM platform_workflows WHERE workflow_id = ?").get(reference.id);
      if (!row) { reasons.push(`${reference.type} ${reference.id} does not exist`); continue; }
      if (row.state !== "completed") { reasons.push(`${reference.type} ${reference.id} is not completed`); continue; }
      refs.push({ type: reference.type, id: reference.id, role: reference.role, name: row.name, observed_at: row.updated_at });
    } else {
      const row = db.prepare("SELECT execution_id, state, project_id, actor_principal_id, updated_at FROM platform_executions WHERE execution_id = ?").get(reference.id);
      if (!row) { reasons.push(`${reference.type} ${reference.id} does not exist`); continue; }
      if (row.state !== "completed") { reasons.push(`${reference.type} ${reference.id} is not completed`); continue; }
      refs.push({ type: reference.type, id: row.execution_id, role: reference.role, project_ref: row.project_id, principal_ref: row.actor_principal_id, observed_at: row.updated_at });
    }
  }
  const configFingerprint = crypto.createHash("sha256").update(JSON.stringify(record.config || {})).digest("hex");
  const healthFingerprint = crypto.createHash("sha256").update(JSON.stringify({ ok: record.health?.ok === true, status: record.health?.status || null })).digest("hex");
  const roles = new Set(refs.map(ref => ref.role));
  const requiredRoles = ["canonical_dispatch", "agent_discovery", "workflow", "single_pack", "cross_pack", "skeptical_verification"];
  const checks = Object.fromEntries(requiredRoles.map(role => [role, roles.has(role)]));
  checks.provider_integration = roles.has("provider_integration");
  for (const role of requiredRoles) if (!roles.has(role)) reasons.push(`required evidence role missing: ${role}`);
  return { ok: reasons.length === 0 && refs.length > 0, reasons, refs, checks, config_fingerprint: configFingerprint, health_fingerprint: healthFingerprint };
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

/** Restore the persisted package metadata captured before an upgrade attempt. */
function restorePackPackage(name, previous) {
  if (!previous || !previous.manifest) throw new Error(`Cannot restore pack "${name}" without the previous package record`);
  return updatePackPackage(name, previous.manifest, {
    packageHash: previous.package_hash,
    installPath: previous.install_path,
    source: previous.source,
    config: previous.config,
    allowSameVersion: true,
    allowDowngrade: true,
  });
}

function deletePack(name) {
  ensureStorage();
  const record = getPack(name);
  if (!record) return { removed: false };
  // One transaction: a crash between the two deletes must not leave ownership
  // rows for a pack that no longer exists (or vice versa).
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM platform_capability_pack_components WHERE pack_name = ?").run(record.name);
    db.prepare("DELETE FROM platform_capability_packs WHERE pack_id = ?").run(record.pack_id);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
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
  PACK_TRANSITIONS,
  COMPONENT_KINDS,
  ensureStorage,
  getPack,
  listPacks,
  registerPack,
  setPackState,
  setPackConfig,
  recordPackHealth,
  recordPackVerification,
  listVerifiedEvidence,
  updatePackPackage,
  restorePackPackage,
  deletePack,
  recordComponent,
  getComponent,
  listComponents,
  findComponentOwner,
  setComponentState,
  removeComponent,
  recordPackEvent,
};
