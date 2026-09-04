"use strict";

// Pack maturity is a derived projection over lifecycle state and attributed
// verification evidence. A manifest can describe requirements, but it cannot
// certify itself.
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LEVELS = Object.freeze(["foundation", "operational", "integrated", "certified"]);

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
  const entries = Array.isArray(record.verified_evidence)
    ? record.verified_evidence.filter(entry => entry && typeof entry === "object")
    : [];
  return { entries, fingerprint: evidenceFingerprint(record), recorded_fingerprint: null };
}

function fresh(entry, now) {
  const observed = parseTime(entry.observed_at);
  const hasExpiry = Object.prototype.hasOwnProperty.call(entry, "expires_at");
  const expires = hasExpiry ? parseTime(entry.expires_at) : Infinity;
  return Number.isFinite(observed) && now - observed >= 0 && now - observed <= MAX_EVIDENCE_AGE_MS
    && (!hasExpiry ? true : Number.isFinite(expires) && now <= expires);
}

function evaluate(record, { now = Date.now() } = {}) {
  if (!record) return { level: null, levels: {}, evidence: [], reasons: ["pack_not_found"] };
  const evidence = evidenceState(record);
  const health = record.health || {};
  const operational = record.state === "enabled" && health.ok === true && health.status === "healthy";
  const lifecycleEpoch = Number(record.metadata?.maturity_lifecycle_epoch || 0);
  const ordered = [...evidence.entries].sort((a, b) => (parseTime(b.observed_at) || 0) - (parseTime(a.observed_at) || 0));
  const current = ordered.find(entry => fresh(entry, now)
    && entry.pack_version === record.version
    && (entry.package_hash || null) === (record.package_hash || null)
    && entry.config_fingerprint === configFingerprint(record)
    && Number(entry.lifecycle_epoch) === lifecycleEpoch
    && entry.health_fingerprint === healthFingerprint(record)
    ? entry : null) || null;
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
  if (!current) reasons.push(evidence.entries.length ? "verification_evidence_stale_or_mismatched" : "verification_evidence_missing");
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
    evidence: evidence.entries.map(entry => ({
      id: entry.id || null,
       observed_at: entry.observed_at || null,
       expires_at: entry.expires_at || null,
       source: entry.source || null,
      checks: entry.checks || {},
      evidence_refs: entry.evidence_refs || [],
      result_digest: entry.result_digest || null,
      recipe_version: entry.recipe_version || null,
      provider: entry.provider || null,
      current: entry === current,
    })),
    evidence_fingerprint: evidence.fingerprint,
    evidence_freshness: current ? "fresh" : evidence.entries.length ? "stale" : "missing",
    reasons,
    optional_provider_integration: has("provider_integration") ? "verified" : "not_verified",
    provider_verified: has("provider_integration"),
    evaluated_at: new Date(now).toISOString(),
  };
}

module.exports = { LEVELS, MAX_EVIDENCE_AGE_MS, evidenceFingerprint, configFingerprint, healthFingerprint, evaluate };
