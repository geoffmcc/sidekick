"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "dashboard.html"), "utf8");
const client = fs.readFileSync(path.join(root, "static", "dashboard.js"), "utf8");
const controls = fs.readFileSync(path.join(root, "static", "dashboard-controls.js"), "utf8");
const systemControls = fs.readFileSync(path.join(root, "static", "dashboard-system.js"), "utf8");

const names = [...new Set([...((html + "\n" + client).matchAll(/data-dashboard-(?:handler|input|change)="([^"]+)"/g))]
  .map(match => match[1]))];
const registryStart = controls.indexOf("const DASHBOARD_HANDLER_REGISTRY");
const registryEnd = controls.indexOf("});", registryStart);
const registry = controls.slice(registryStart, registryEnd);

assert.ok(registryStart >= 0, "dashboard handler registry is required");
assert.match(controls, /Object\.freeze\(/, "handler registry must be frozen");
assert.ok(!/window\s*\[/.test(controls), "controls must not dynamically look up window properties");
assert.ok(!/eval\s*\(|new Function\s*\(|\bFunction\s*\(/.test(controls), "controls must not evaluate handler names");
for (const name of names) assert.match(registry, new RegExp("\\b" + name + "\\b"), "handler missing from registry: " + name);

for (const name of ["startAgentContinuation", "submitFollowup", "reviewAgentLearningCandidate", "runEvolveTrial", "retryBlackboxCapture"]) {
  assert.match(controls, new RegExp('handler === "' + name + '"'), "adapter missing: " + name);
}
for (const name of ["runAgent", "streamAgentTask", "submitFollowup", "restoreAgentState", "finishAgentStream", "clearAgent", "stopAgent", "toggleHistory"]) {
  assert.strictEqual((client.match(new RegExp("function " + name + "\\s*\\(", "g")) || []).length, 1, "duplicate Agent definition: " + name);
}
assert.match(controls, /Unsupported compute .*action/);
assert.match(controls, /\["enable", "disable", "revoke"\]/);
assert.match(controls, /\["cancel", "retry"\]/);
assert.strictEqual((systemControls.match(/selector\.addEventListener\(['"]change['"],/g) || []).length, 1,
  "tool-stats-window must retain exactly one change owner");
assert.match(controls, /single owner of this control/);

// Exercise the adapters without a browser or DOM implementation.
const calls = [];
const handlerNames = [...new Set([...registry.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:,|$)/gm)].map(match => match[1]))];
const prelude = handlerNames.map(name => "function " + name + "(...args) { calls.push([" + JSON.stringify(name) + ", args]); }").join("\n");
const listeners = {};
const context = {
  calls,
  console: { error() {} },
  window: {},
  showToast() { calls.push(["showToast", [...arguments]]); },
  document: { addEventListener(type, fn) { listeners[type] = fn; } }
};
vm.runInNewContext(prelude + "\n" + controls, context);
function click(dataset) {
  const control = { dataset, value: dataset.value, closest(selector) {
    return selector === "[data-dashboard-action]" ? control : null;
  }};
  listeners.click({ target: control });
}

click({ dashboardAction: "agent", handler: "startAgentContinuation", value: "verify" });
click({ dashboardAction: "agent", handler: "submitFollowup", id: "task-1" });
click({ dashboardAction: "callback", handler: "reviewAgentLearningCandidate", id: "candidate-1", index: "project:one", value: "trial" });
click({ dashboardAction: "evolve", handler: "runEvolveTrial", id: "candidate-2", index: "3" });
click({ dashboardAction: "callback", handler: "retryBlackboxCapture", id: "capture-1", index: "incident-1" });
assert.strictEqual(JSON.stringify(calls.slice(0, 5)), JSON.stringify([
  ["startAgentContinuation", ["verify"]],
  ["submitFollowup", ["task-1"]],
  ["reviewAgentLearningCandidate", ["candidate-1", "project:one", "trial"]],
  ["runEvolveTrial", ["candidate-2", "3"]],
  ["retryBlackboxCapture", ["capture-1", "incident-1"]]
]));

click({ dashboardAction: "compute-worker", id: "worker-1", value: "unsupported" });
assert.ok(!calls.some(call => call[0] === "computeWorkerAction"), "unsupported worker action must not invoke the handler");
click({ dashboardAction: "callback", handler: "notAllowlisted", id: "x" });
assert.ok(calls.some(call => call[0] === "showToast"), "unknown handlers must produce a visible toast when available");
click({ dashboardAction: "callback", handler: "__proto__", id: "x" });
assert.ok(calls.some(call => call[0] === "showToast"), "prototype-property handlers must not dispatch");

console.log("Dashboard controls contract: passed");
