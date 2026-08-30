"use strict";

const os = require("os");
const { redactSensitive, redactSensitiveKeysDeep } = require("./redact");
const { getLocalPaths } = require("./local/paths");
const { getPathPolicyDecision } = require("./tools/path-policy");
const { evaluateInvariants, SEVERITY_ORDER } = require("./invariants");
const packageJson = require("../package.json");
const { collectReliabilityMetrics } = require("./certification/metrics");

const MAX_TEXT = 4000;

function safeText(value) {
  return redactSensitive(String(value == null ? "" : value)).replace(/[\r\n]+/g, " ").slice(0, 300);
}

function runDoctor(options = {}) {
  const invariantReport = options.invariants || evaluateInvariants(options);
  const checks = [...(invariantReport.checks || [])];
  let paths;
  try {
    paths = (options.paths || getLocalPaths());
    const decisions = ["db", "data", "backups"].map(key => {
      const decision = (options.pathPolicy || getPathPolicyDecision)(paths[key], "read", "doctor");
      return { target: key, allowed: Boolean(decision.allowed), reason: safeText(decision.reason) };
    });
    checks.push({ id: "path.policy", ok: decisions.every(item => item.allowed), severity: decisions.every(item => item.allowed) ? "ok" : "warning", message: decisions.every(item => item.allowed) ? "Doctor paths satisfy policy" : "Doctor path policy denied one or more paths", details: { decisions } });
  } catch (error) {
    checks.push({ id: "path.policy", ok: false, severity: "warning", message: "Path policy could not be evaluated", details: { error: safeText(error.message || error) } });
  }

  const failed = checks.filter(item => !item.ok);
  const severity = checks.reduce((worst, item) => SEVERITY_ORDER[item.severity] > SEVERITY_ORDER[worst] ? item.severity : worst, "ok");
  let reliability;
  try { reliability = collectReliabilityMetrics(options); } catch (error) { reliability = { schema: "sidekick.reliability.v1", available: false, reason: safeText(error.message || error) }; }
  return redactSensitiveKeysDeep({
    ok: failed.length === 0,
    severity,
    generated_at: new Date().toISOString(),
    runtime: { version: packageJson.version, node: process.version, platform: os.platform(), arch: os.arch() },
    reliability,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  });
}

function formatDoctorText(report) {
  const lines = [`Sidekick Doctor: ${report.ok ? "OK" : String(report.severity || "failed").toUpperCase()}`];
  for (const item of (report.checks || []).slice(0, 100)) {
    lines.push(`${item.ok ? "PASS" : String(item.severity || "FAIL").toUpperCase()} ${safeText(item.id)}: ${safeText(item.message)}`);
  }
  return lines.join("\n").slice(0, MAX_TEXT);
}

function createSupportBundle(options = {}) {
  const report = options.report || runDoctor(options);
  return redactSensitiveKeysDeep({
    format: "sidekick-support-v1",
    generated_at: report.generated_at,
    doctor: report,
    note: "Diagnostic metadata only; credentials, raw rows, and filesystem contents are excluded.",
  });
}

module.exports = { runDoctor, formatDoctorText, createSupportBundle };
