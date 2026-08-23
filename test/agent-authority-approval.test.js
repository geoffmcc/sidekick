"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-agent-authority-approval-"));
process.env.NODE_ENV = "test";
process.env.SIDEKICK_DATA_DIR = data;
process.env.SIDEKICK_SECRET_KEY_FILE = path.join(data, "secret");
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_TOOL_POLICY = "open";
fs.writeFileSync(process.env.SIDEKICK_SECRET_KEY_FILE, "test-only-key");

const { callAgentTool } = require("../src/tools/dispatcher");
const { createAuthorityEnvelope, intersectEnvelope, decideAutonomy } = require("../src/agent/authority");
const target = path.join(data, "must-not-be-written.txt");

(async () => {
  try {
    const principal = createAuthorityEnvelope({
      allowed_effects: ["read_only", "workspace_reversible"],
      changes_allowed: true,
      permitted_projects: ["project:demo"],
    });
    const defaultRequest = createAuthorityEnvelope({
      allowed_effects: ["read_only", "workspace_reversible", "external"],
      changes_allowed: true,
    });
    const effective = intersectEnvelope(defaultRequest, principal);
    const routine = decideAutonomy({
      descriptor: { name: "write", version: 1, annotations: { readOnlyHint: false }, risk: "medium" },
      args: { path: "workspace:demo", content: "bounded" },
      envelope: effective,
      projectRef: "project:demo",
      workspaceRef: "workspace:demo",
      capabilityRef: "write",
      principalRef: "principal:operator",
    });
    assert.strictEqual(routine.decision, "proceed", "safe requested work must remain autonomous inside principal scope");
    assert.strictEqual(effective.allowed_effects.includes("external"), false, "task request cannot expand principal effects");

    const result = await callAgentTool("write", { path: target, content: "approval boundary" }, {
      taskId: "agt_authority_approval",
      source: "agent",
      authorityApprovalRequired: true,
      authorityRisk: "critical",
      authorityReason: "task envelope requires explicit approval",
    });
    assert.strictEqual(result.code, "approval_required");
    assert.strictEqual(result.approvalRequired, true);
    assert.strictEqual(fs.existsSync(target), false, "authority approval must gate the handler");
    console.log("Agent authority approval: passed");
  } finally {
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
