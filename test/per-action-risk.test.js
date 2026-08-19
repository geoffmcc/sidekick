"use strict";

// Per-action tool risk: a tool that both reads and mutates must not force its
// most dangerous label onto its read-only actions. Guards the fail-closed
// direction hard, because the only thing worse than an extra approval prompt is
// a mutating call that quietly stops asking for one.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-per-action-risk");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";
// The approval queue encrypts reason/args at rest, so queueing needs a key. Without
// it the queue fails and a required-approval case reports as unavailable instead.
process.env.SIDEKICK_SECRET_KEY = "per-action-risk-test-key";
// This suite tests approval decisions for explicitly reachable capability
// actions. The production default is restricted/strict; opt into the legacy
// tool policy so policy does not preempt the approval assertions.
process.env.SIDEKICK_TOOL_POLICY = "open";

delete require.cache[require.resolve("../src/db")];
const legacy = require("../src/tools-legacy");
const { TOOL_ACTION_RISK, TOOL_RISK } = require("../src/tools/metadata");

console.log("Running per-action tool risk tests...\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function withApprovalMode(mode, fn) {
  const previous = process.env.SIDEKICK_APPROVAL_MODE;
  process.env.SIDEKICK_APPROVAL_MODE = mode;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.SIDEKICK_APPROVAL_MODE;
    else process.env.SIDEKICK_APPROVAL_MODE = previous;
  }
}

// ---- resolution -------------------------------------------------------------

test("a read-only action resolves below its tool-level risk", () => {
  assert.strictEqual(TOOL_RISK.capability, "critical", "the tool itself stays critical");
  assert.strictEqual(legacy.getToolRisk("capability", { action: "list" }), "low");
  assert.strictEqual(legacy.getToolRisk("capability", { action: "show", name: "developer" }), "low");
  assert.strictEqual(legacy.getToolRisk("capability", { action: "health", name: "developer" }), "low");
});

test("a mutating action keeps the tool-level risk", () => {
  for (const action of ["install", "enable", "disable", "configure", "upgrade", "uninstall"]) {
    assert.strictEqual(legacy.getToolRisk("capability", { action }), "critical", `${action} must stay critical`);
  }
});

test("inspect is deliberately not downgraded", () => {
  // It reads a caller-supplied path, so it keeps the tool-level risk.
  assert.ok(!("inspect" in TOOL_ACTION_RISK.capability));
  assert.strictEqual(legacy.getToolRisk("capability", { action: "inspect", path: "/tmp/pack" }), "critical");
});

test("an unknown or malformed action fails closed to the tool risk", () => {
  assert.strictEqual(legacy.getToolRisk("capability", { action: "frobnicate" }), "critical");
  assert.strictEqual(legacy.getToolRisk("capability", {}), "critical", "a missing action cannot downgrade");
  assert.strictEqual(legacy.getToolRisk("capability", { action: "" }), "critical");
  assert.strictEqual(legacy.getToolRisk("capability", { action: 123 }), "critical", "a non-string action cannot downgrade");
  assert.strictEqual(legacy.getToolRisk("capability", { action: ["list"] }), "critical");
  assert.strictEqual(legacy.getToolRisk("capability", null), "critical");
  assert.strictEqual(legacy.getToolRisk("capability"), "critical", "no args at all keeps the tool risk");
});

test("prototype-chain actions cannot lower risk", () => {
  // The tool-name lookup already fails closed this way; the action lookup must too.
  assert.strictEqual(legacy.getToolRisk("capability", { action: "__proto__" }), "critical");
  assert.strictEqual(legacy.getToolRisk("capability", { action: "constructor" }), "critical");
  assert.strictEqual(legacy.getToolRisk("capability", { action: "hasOwnProperty" }), "critical");
  assert.strictEqual(legacy.getToolRisk("__proto__", { action: "list" }), "critical");
});

test("a tool with no action overrides is unaffected by an action argument", () => {
  // bash is critical and has no per-action table; passing an action must not
  // reach into another tool's overrides.
  assert.strictEqual(legacy.getToolRisk("bash", { action: "list" }), legacy.getToolRisk("bash"));
  assert.strictEqual(legacy.getToolRisk("knowledge", { action: "list" }), legacy.getToolRisk("knowledge"));
});

test("workflow reads resolve low while run and resume stay high", () => {
  // GET /api/capabilities/:name/workflows dispatches workflow action=list.
  assert.strictEqual(TOOL_RISK.workflow, "high");
  assert.strictEqual(legacy.getToolRisk("workflow", { action: "list" }), "low");
  assert.strictEqual(legacy.getToolRisk("workflow", { action: "show", name: "developer/ci-triage" }), "low");
  assert.strictEqual(legacy.getToolRisk("workflow", { action: "run", name: "x" }), "high", "running a workflow dispatches governed tool calls");
  assert.strictEqual(legacy.getToolRisk("workflow", { action: "resume", name: "x" }), "high");
});

test("strict mode stops prompting for workflow reads but not workflow runs", () => {
  withApprovalMode("strict", () => {
    assert.strictEqual(legacy.getApprovalDecision("workflow", "dashboard", { action: "list" }).required, false);
    assert.strictEqual(legacy.getApprovalDecision("workflow", "dashboard", { action: "run", name: "x" }).required, true);
  });
});

// ---- approval decisions -----------------------------------------------------

test("risky mode stops demanding approval for browsing capability packs", () => {
  // The reported symptom: opening the dashboard Capabilities tab filed a
  // critical approval, and rejecting it just produced another on refetch.
  withApprovalMode("risky", () => {
    const list = legacy.getApprovalDecision("capability", "dashboard", { action: "list" });
    assert.strictEqual(list.required, false, "listing packs no longer requires approval");
    assert.strictEqual(list.risk, "low");
  });
});

test("risky mode still demands approval for installing a pack", () => {
  withApprovalMode("risky", () => {
    const install = legacy.getApprovalDecision("capability", "dashboard", { action: "install", name: "x" });
    assert.strictEqual(install.required, true, "the prompt that matters is preserved");
    assert.strictEqual(install.risk, "critical");
    const noArgs = legacy.getApprovalDecision("capability", "dashboard");
    assert.strictEqual(noArgs.required, true, "callers that pass no args keep the strict decision");
  });
});

test("strict mode keeps approving high and critical actions only", () => {
  withApprovalMode("strict", () => {
    assert.strictEqual(legacy.getApprovalDecision("capability", "dashboard", { action: "list" }).required, false);
    assert.strictEqual(legacy.getApprovalDecision("capability", "dashboard", { action: "enable", name: "x" }).required, true);
  });
});

test("approval mode off is unchanged by any of this", () => {
  withApprovalMode("off", () => {
    assert.strictEqual(legacy.getApprovalDecision("capability", "dashboard", { action: "install" }).required, false);
  });
});

// ---- policy decisions -------------------------------------------------------

test("tool policy sees the same effective risk as approval", () => {
  // Otherwise a restricted policy would still block a read that approval now
  // permits, and the tab would fail instead of prompting.
  const list = legacy.getToolPolicyDecision("capability", "dashboard", { action: "list" });
  const install = legacy.getToolPolicyDecision("capability", "dashboard", { action: "install" });
  assert.strictEqual(list.risk, "low");
  assert.strictEqual(install.risk, "critical");
});

// ---- the seam ---------------------------------------------------------------
//
// The unit assertions above all passed once before, in a sibling change, while
// the behaviour was still broken at the dispatcher boundary. So this asserts the
// thing actually reported: a real dispatched call, through policy and approval,
// the way the dashboard makes it.

(async () => {
  const { callDashboardTool } = require("../src/tools");

  await (async function seam(name, fn) {
    try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
  })("a dispatched capability list does not queue an approval in risky mode", async () => {
    process.env.SIDEKICK_APPROVAL_MODE = "risky";
    const result = await callDashboardTool("capability", { action: "list" }, { actor: "dashboard" });
    const text = result?.content?.[0]?.text || "";
    assert.ok(!/Approval required/.test(text), `listing packs still demanded approval: ${text.slice(0, 160)}`);
  });

  await (async function seam(name, fn) {
    try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
  })("a dispatched capability install still queues an approval in risky mode", async () => {
    process.env.SIDEKICK_APPROVAL_MODE = "risky";
    const result = await callDashboardTool("capability", { action: "install", name: "developer" }, { actor: "dashboard" });
    const text = result?.content?.[0]?.text || "";
    assert.ok(/Approval required/.test(text), `installing a pack no longer demanded approval: ${text.slice(0, 160)}`);
  });

  delete process.env.SIDEKICK_APPROVAL_MODE;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
