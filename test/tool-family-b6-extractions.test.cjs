"use strict";

// Regression net for Track B slice B-6 — the final extraction that leaves
// ZERO legacy-owned production handlers in src/tools-legacy.js. Asserts every
// B-6 handler resolves as a family-owned builtin at its pre-move risk, that no
// legacy TOOLS entry survives for it, that the nested-dispatch seam and the
// shared helper modules are wired, that the compatibility exports the dashboard
// and agent depend on still resolve through the facade, and — via cheap
// validation-error paths — that the moved handler bodies actually run (these
// nine had no prior coverage: teach, queue, retry, orchestrate, batch, circuit,
// runbook, watch, secret).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-b6-"));
process.env.SIDEKICK_DATA_DIR = testDataDir;

delete require.cache[require.resolve("../src/tools")];
const tools = require("../src/tools");
const legacy = require("../src/tools-legacy");
const registry = tools.getBuiltinRegistry();

// name -> [family, risk]
const EXPECTED = {
  github: ["github", "high"],
  ci_status: ["github", "low"],
  secret: ["secret", "high"],
  resume: ["resume", "low"],
  project: ["context", "low"],
  teach: ["teach", "high"],
  queue: ["flow-control", "high"],
  retry: ["flow-control", "medium"],
  orchestrate: ["flow-control", "high"],
  batch: ["flow-control", "medium"],
  circuit: ["flow-control", "medium"],
  mission: ["operations", "critical"],
  cron: ["scheduling", "high"],
  delay: ["scheduling", "high"],
  watch: ["scheduling", "high"],
  runbook: ["runbook", "critical"],
  evolve: ["evolve", "critical"],
  tools: ["tool-catalog", "low"],
};

(async () => {
  for (const [name, [family, risk]] of Object.entries(EXPECTED)) {
    const d = registry.get(name);
    assert.ok(d, `${name} should resolve from the registry`);
    assert.strictEqual(d.source, "builtin", `${name} source`);
    assert.strictEqual(d.family, family, `${name} family`);
    assert.strictEqual(d.risk, risk, `${name} risk must match its pre-move classification`);
    assert.strictEqual(typeof d.handler, "function", `${name} handler`);
    assert.ok(!Object.prototype.hasOwnProperty.call(legacy.TOOLS, name), `${name} should have no legacy TOOLS entry`);
  }

  // Milestone: zero legacy-owned production handlers remain (only the six
  // compute-delegated pass-throughs are allowed in the legacy TOOLS map).
  const legacyOwned = Object.keys(legacy.TOOLS).filter(k => !k.startsWith("compute"));
  assert.deepStrictEqual(legacyOwned, [], `tools-legacy.js should own no non-compute handlers, found: ${legacyOwned.join(", ")}`);

  // The shared helper modules exist and are dependency-safe leaves.
  assert.strictEqual(typeof require("../src/tools/dispatch-seam").callTool, "function");
  assert.strictEqual(typeof require("../src/core/ids").generateId, "function");
  assert.strictEqual(typeof require("../src/core/procedures-store").loadProcedures, "function");
  assert.strictEqual(typeof require("../src/core/secrets-store").loadSecrets, "function");
  assert.strictEqual(typeof require("../src/tools/scheduled-execution").createScheduledPlatformExecution, "function");

  // No family may require tools-legacy.js at module load (the cycle invariant).
  const familiesDir = path.join(__dirname, "..", "src", "tools", "families");
  for (const file of fs.readdirSync(familiesDir).filter(f => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(familiesDir, file), "utf8");
    assert.ok(!/require\(["']\.\.\/\.\.\/tools-legacy["']\)/.test(src), `${file} must not require tools-legacy.js`);
  }

  // Compatibility exports the dashboard and agent destructure must survive.
  for (const n of [
    "buildPolicyInspection", "summarizePolicyInspection", "missionRoute",
    "recoverStrandedRunbooks", "recoverStrandedDelays", "pauseWatchForCancel",
    "loadDelays", "saveDelays", "loadWatches", "saveWatches",
    "parseGithubArgs", "getGithubArg", "getCiRevisionSelector",
    "buildCiStatusResult", "formatCiStatusText",
  ]) {
    assert.strictEqual(typeof tools[n], "function", `facade must still export ${n}`);
  }

  // Cheap validation-error paths — run each moved body with no side effects.
  const invalid = async (name, args) => (await registry.get(name).handler(args)).content[0].text;
  assert.match(await invalid("teach", { action: "zzz" }), /Unknown action|Invalid action/i);
  assert.match(await invalid("queue", { action: "zzz" }), /Unknown action|Invalid action/i);
  assert.match(await invalid("orchestrate", { action: "zzz" }), /Unknown action|Invalid action/i);
  assert.match(await invalid("circuit", { action: "zzz" }), /Unknown action|Invalid action/i);
  assert.match(await invalid("secret", { action: "zzz" }), /Unknown action|Invalid action|SECRET_KEY/i);
  assert.match(await invalid("watch", { action: "zzz" }), /Unknown action|Invalid action/i);
  assert.match(await invalid("runbook", { action: "zzz" }), /Unknown action|Invalid action/i);
  assert.match(await invalid("cron", { action: "zzz" }), /Unknown action|Invalid action/i);
  assert.match(await invalid("retry", { tool: "" }), /required|Error/i);
  // batch's isBuiltinToolName path (moved with the handler) still recognizes builtins.
  const batchKnown = await invalid("batch", { calls: [{ tool: "hash", args: {} }] });
  assert.ok(!/Unknown tool/.test(batchKnown), "batch must recognize a builtin tool name");
  const batchUnknown = await invalid("batch", { calls: [{ tool: "zzz-nope", args: {} }] });
  assert.match(batchUnknown, /Unknown tool/, "batch must reject an unknown tool name");

  // tools catalog runs through its lazily-resolved policy helpers.
  for (const a of [{ action: "overview" }, { action: "search", query: "git" }, { action: "get", name: "bash" }, { action: "policy", name: "bash" }]) {
    const r = await registry.get("tools").handler(a);
    assert.ok(!r.isError, `tools ${a.action} should succeed`);
  }

  console.log("B-6 extraction family tests passed");
})().catch(e => { console.error(e); process.exit(1); });
