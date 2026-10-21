"use strict";

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-flow-control-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
const { dispatchTestTool } = require("../src/tools/dispatcher");
const { descriptors, sidekick_queue, sidekick_retry, runRetryAttempts, sidekick_orchestrate, sidekick_batch, sidekick_circuit } = require("../src/tools/families/flow-control");

const retryDescriptor = descriptors.find(descriptor => descriptor.name === "retry");
after(() => {
  try { require("../src/db").closeDatabase(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("flow-control handlers reject calls outside authenticated canonical dispatch", async () => {
  assert.equal((await sidekick_queue({ action: "list" })).code, "forbidden");
  assert.equal((await sidekick_orchestrate({ action: "list" })).code, "forbidden");
  assert.equal((await sidekick_batch({ calls: [{ tool: "respond", args: { text: "no" } }] })).code, "canonical_dispatch_required");
  assert.equal((await sidekick_circuit({ action: "list" })).code, "canonical_dispatch_required");
});

test("retry schema rejects invalid attempt and delay bounds", async () => {
  for (const args of [
    { tool: "respond", max_attempts: 0 },
    { tool: "respond", max_attempts: 1.5 },
    { tool: "respond", max_attempts: 11 },
    { tool: "respond", initial_delay: -1 },
    { tool: "respond", initial_delay: 60001 },
  ]) {
    const result = await dispatchTestTool({ descriptor: retryDescriptor, args, context: { source: "test" } });
    assert.equal(result.isError, true, `invalid retry options must fail: ${JSON.stringify(args)}`);
  }
});

test("retry handler refuses calls outside canonical dispatch", async () => {
  const result = await sidekick_retry({ tool: "respond", max_attempts: 4, initial_delay: 0 });
  assert.equal(result.isError, true);
  assert.equal(result.code, "canonical_dispatch_required");
});

test("retry policy helper cannot dispatch without an explicit callback", async () => {
  await assert.rejects(
    () => runRetryAttempts({ tool: "respond", args: {}, maxAttempts: 1, initialDelay: 0, backoffType: "fixed" }),
    /invocation callback is required/,
  );
});

test("retry does not repeat policy, approval, permission, or validation failures", async () => {
  for (const code of ["policy_denied", "approval_required", "validation_failed", "permission_denied"]) {
    let calls = 0;
    const result = await runRetryAttempts(
      { tool: "respond", args: {}, maxAttempts: 4, initialDelay: 0, backoffType: "fixed" },
      async () => {
        calls++;
        return { isError: true, code, content: [{ type: "text", text: `${code} response` }] };
      },
      async () => assert.fail("denied operations must not wait for another attempt"),
    );
    assert.equal(calls, 1, `${code} must not be retried`);
    assert.equal(result.isError, true);
  }
});

test("retry preserves bounded retries for transient failures", async () => {
  let calls = 0;
  let waits = 0;
  const result = await runRetryAttempts(
    { tool: "respond", args: {}, maxAttempts: 3, initialDelay: 0, backoffType: "fixed" },
    async () => {
      calls++;
      return { isError: true, code: "temporary_unavailable", content: [{ type: "text", text: "temporarily unavailable" }] };
    },
    async () => { waits++; },
  );
  assert.equal(calls, 3);
  assert.equal(waits, 2);
  assert.equal(result.isError, true);
});
