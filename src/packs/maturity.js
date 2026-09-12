"use strict";

// Pack maturity is a derived projection over lifecycle state and attributed
// verification evidence. A manifest can describe requirements, but it cannot
// certify itself.
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LEVELS = Object.freeze(["foundation", "operational", "integrated", "certified"]);
const EVIDENCE_STATES = Object.freeze(["fresh", "stale", "dirty", "malformed", "expired"]);

function parseTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : NaN;
}

function evidenceFingerprint(record) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(JSON.stringify({
    package_hash: record.package_hash || null,
    version: record.version,
    config: record.config || {},
    lifecycle_epoch: record.metadata?.maturity_lifecycle_epoch || 0,
    health: { ok: record.health?.ok === true, status: record.health?.status || null },
  })).digest("hex");
}

function configFingerprint(record) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(JSON.stringify(record.config || {})).digest("hex");
}

function healthFingerprint(record) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(JSON.stringify({ ok: record.health?.ok === true, status: record.health?.status || null })).digest("hex");
}

function evidenceState(record) {
  // Only server-validated rows are certification evidence. The metadata field
  // is retained for historical inspection, but is deliberately not consulted.
  const rawEntries = Array.isArray(record.verified_evidence) ? record.verified_evidence : [];
  const entries = rawEntries.filter(entry => entry && typeof entry === "object" && !Array.isArray(entry));
  return { entries, malformed: rawEntries.length - entries.length, fingerprint: evidenceFingerprint(record) };
}

function classifyEvidence(entry, record, now) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "malformed";
  const observed = parseTime(entry.observed_at);
  const hasExpiry = Object.prototype.hasOwnProperty.call(entry, "expires_at");
  const expires = hasExpiry ? parseTime(entry.expires_at) : Infinity;
  const required = ["observed_at", "pack_version", "config_fingerprint", "lifecycle_epoch", "health_fingerprint", "checks"];
  if (!required.every(field => Object.prototype.hasOwnProperty.call(entry, field)) || !Number.isFinite(observed) || (hasExpiry && !Number.isFinite(expires)) || !entry.checks || typeof entry.checks !== "object" || Array.isArray(entry.checks)) return "malformed";
  if (hasExpiry && now > expires) return "expired";
  if (now < observed || now - observed > MAX_EVIDENCE_AGE_MS) return "stale";
  if (entry.pack_version !== record.version
    || (entry.package_hash || null) !== (record.package_hash || null)
    || entry.config_fingerprint !== configFingerprint(record)
    || Number(entry.lifecycle_epoch) !== Number(record.metadata?.maturity_lifecycle_epoch || 0)
    || entry.health_fingerprint !== healthFingerprint(record)) return "dirty";
  return "fresh";
}

function evaluate(record, { now = Date.now() } = {}) {
  if (!record) return { level: null, levels: {}, evidence: [], reasons: ["pack_not_found"] };
  const evidence = evidenceState(record);
  const health = record.health || {};
  const operational = record.state === "enabled" && health.ok === true && health.status === "healthy";
  const lifecycleEpoch = Number(record.metadata?.maturity_lifecycle_epoch || 0);
  const ordered = [...evidence.entries].sort((a, b) => (parseTime(b.observed_at) || 0) - (parseTime(a.observed_at) || 0));
  const classified = ordered.map(entry => ({ entry, state: classifyEvidence(entry, record, now) }));
  const current = classified.find(item => item.state === "fresh")?.entry || null;
  const requiredChecks = ["canonical_dispatch", "agent_discovery", "workflow", "single_pack", "cross_pack", "skeptical_verification"];
  const has = key => current?.checks?.[key] === true;
  const integrated = operational && has("canonical_dispatch") && has("agent_discovery") && has("workflow");
  const certified = integrated && has("single_pack") && has("cross_pack") && has("skeptical_verification");
  let level = "foundation";
  if (operational) level = "operational";
  if (integrated) level = "integrated";
  if (certified) level = "certified";
  const satisfiedChecks = requiredChecks.filter(has);
  const missingChecks = requiredChecks.filter(check => !has(check));
  const reasons = [];
  if (record.state !== "enabled") reasons.push(`pack_state:${record.state}`);
  if (!health.ok || health.status !== "healthy") reasons.push(`health:${health.status || "unknown"}`);
  if (!current) {
    if (!evidence.entries.length && !evidence.malformed) reasons.push("verification_evidence_missing");
    else if (classified.some(item => item.state === "malformed") || evidence.malformed) reasons.push("verification_evidence_malformed");
    else if (classified.some(item => item.state === "expired")) reasons.push("verification_evidence_expired");
    else if (classified.some(item => item.state === "dirty")) reasons.push("verification_evidence_dirty");
    else reasons.push("verification_evidence_stale");
  }
  if (current) {
    for (const check of missingChecks) reasons.push(`verification_missing:${check}`);
  }
  const nextLevel = certified ? null : integrated ? "certified" : operational ? "integrated" : "operational";
  const nextAction = !record
    ? "Install the capability pack."
    : record.state !== "enabled"
      ? "Enable the capability pack, then run a health check."
      : !health.ok || health.status !== "healthy"
        ? "Repair the reported health prerequisite and run a health check."
        : current
          ? `Run verification for the missing checks: ${missingChecks.join(", ") || "none"}.`
          : "Run the server-side pack verification recipe to create current evidence.";
  return {
    level,
    levels: { foundation: true, operational, integrated, certified },
    pack_state: record.state,
    health: { status: health.status || "unknown", ok: health.ok === true, checked_at: health.checked_at || null },
    next_level: nextLevel,
    satisfied_checks: satisfiedChecks,
    missing_checks: missingChecks,
    next_action: nextAction,
    evidence: classified.map(({ entry, state }) => ({
      id: entry.id || null,
      observed_at: entry.observed_at || null,
      expires_at: entry.expires_at || null,
      source: entry.source || null,
      checks: entry.checks || {},
      evidence_refs: entry.evidence_refs || [],
      result_digest: entry.result_digest || null,
      recipe_version: entry.recipe_version || null,
      provider: entry.provider || null,
      state,
      current: entry === current,
    })),
    evidence_fingerprint: evidence.fingerprint,
    evidence_freshness: current ? "fresh" : evidence.malformed ? "malformed" : classified.some(item => item.state === "malformed") ? "malformed" : classified.some(item => item.state === "expired") ? "expired" : classified.some(item => item.state === "dirty") ? "dirty" : classified.length ? "stale" : "missing",
    evidence_states: Object.fromEntries(EVIDENCE_STATES.map(state => [state, classified.filter(item => item.state === state).length])),
    reasons,
    optional_provider_integration: has("provider_integration") && current?.provider?.verified === true ? "verified" : "not_verified",
    provider_verified: has("provider_integration") && current?.provider?.verified === true,
    evaluated_at: new Date(now).toISOString(),
  };
}

module.exports = { LEVELS, EVIDENCE_STATES, MAX_EVIDENCE_AGE_MS, evidenceFingerprint, configFingerprint, healthFingerprint, classifyEvidence, evaluate };
