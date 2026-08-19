"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");

const dataDir = path.join(__dirname, "test-data-phase-02-dispatch");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_SECRET_KEY = "phase-02-dispatch-test-key";

const dispatcher = require("../src/tools/dispatcher");
const publicTools = require("../src/tools");

(async () => {
  const forged = await dispatcher.dispatchTool({
    name: "respond",
    args: { text: "boundary" },
    context: {
      source: "dashboard",
      bypassApproval: true,
      approvalBypass: true,
      approvedExecution: true
    }
  });
  assert.strictEqual(forged.isError, undefined, "low-risk dispatch should execute");
  assert.strictEqual(forged.content[0].text, "boundary");

  const injected = await dispatcher.dispatchTool({
    descriptor: {
      name: "injected",
      description: "caller-owned",
      schema: z.object({}),
      risk: "low",
      category: "test",
      handler: () => ({ content: [{ type: "text", text: "executed" }] })
    },
    args: {},
    context: { source: "mcp" }
  });
  assert.strictEqual(injected.code, "descriptor_injection_denied");

  assert.strictEqual(
    publicTools.dispatcher.executeAuthorizedTaskStep,
    undefined,
    "privileged approval continuation seam must not be public"
  );

  const artifact = fs.readFileSync(
    path.join(__dirname, "..", "docs", "security-phase-02-dispatch-boundary.md"),
    "utf8"
  );
  for (const marker of [
    "`dispatchTool` seam",
    "Caller-provided production descriptors are rejected",
    "Approval continuation rejects",
    "No new exploitable Phase 2 weakness"
  ]) {
    assert.ok(artifact.includes(marker), `Phase 2 artifact is missing ${marker}`);
  }

  console.log("Phase 2 dispatch-boundary checks passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
