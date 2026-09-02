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

function evidenceState(record) {
  const raw = record.metadata?.maturity_evidence;
  if (!raw || typeof raw !== "object") return { entries: [], fingerprint: evidenceFingerprint(record) };
  const entries = Array.isArray(raw.entries) ? raw.entries.filter(entry => entry && typeof entry === "object") : [];
  return { entries, fingerprint: evidenceFingerprint(record), recorded_fingerprint: raw.fingerprint || null };
}

function fresh(entry, now) {
  const observed = parseTime(entry.observed_at);
  return Number.isFinite(observed) && now - observed >= 0 && now - observed <= MAX_EVIDENCE_AGE_MS;
}

function evaluate(record, { now = Date.now() } = {}) {
  if (!record) return { level: null, levels: {}, evidence: [], reasons: ["pack_not_found"] };
  const evidence = evidenceState(record);
  const health = record.health || {};
  const operational = record.state === "enabled" && health.ok === true && health.status === "healthy";
  const matching = evidence.recorded_fingerprint === evidence.fingerprint;
  const latest = [...evidence.entries].sort((a, b) => (parseTime(b.observed_at) || 0) - (parseTime(a.observed_at) || 0))[0] || null;
  const current = latest && matching && fresh(latest, now) ? latest : null;
  const has = key => current?.checks?.[key] === true;
  const integrated = operational && has("canonical_dispatch") && has("agent_discovery") && has("workflow");
  const certified = integrated && has("single_pack") && has("cross_pack") && has("skeptical_verification");
  let level = "foundation";
  if (operational) level = "operational";
  if (integrated) level = "integrated";
  if (certified) level = "certified";
  const reasons = [];
  if (record.state !== "enabled") reasons.push(`pack_state:${record.state}`);
  if (!health.ok || health.status !== "healthy") reasons.push(`health:${health.status || "unknown"}`);
  if (!current) reasons.push(evidence.entries.length ? (matching ? "verification_evidence_stale" : "verification_fingerprint_mismatch") : "verification_evidence_missing");
  if (current) {
    for (const check of ["canonical_dispatch", "agent_discovery", "workflow", "single_pack", "cross_pack", "skeptical_verification"]) {
      if (!has(check)) reasons.push(`verification_missing:${check}`);
    }
  }
  return {
    level,
    levels: { foundation: true, operational, integrated, certified },
    evidence: evidence.entries.map(entry => ({
      id: entry.id || null,
      observed_at: entry.observed_at || null,
      source: entry.source || null,
      checks: entry.checks || {},
      current: entry === current,
    })),
    evidence_fingerprint: evidence.fingerprint,
    evidence_freshness: current ? "fresh" : evidence.entries.length ? "stale" : "missing",
    reasons,
    optional_provider_integration: record.manifest?.provider_requirements ? (has("provider_integration") ? "verified" : "not_verified") : "not_required",
    evaluated_at: new Date(now).toISOString(),
  };
}

module.exports = { LEVELS, MAX_EVIDENCE_AGE_MS, evidenceFingerprint, evaluate };
