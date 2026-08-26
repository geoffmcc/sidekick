"use strict";

const assert = require("assert");
const dispatcher = require("../src/tools/dispatcher");
const { sidekick_retry } = require("../src/tools/families/flow-control");

const originalDispatch = dispatcher.dispatchTool;

async function run() {
  for (const args of [
    { tool: "respond", max_attempts: 0 },
    { tool: "respond", max_attempts: 1.5 },
    { tool: "respond", max_attempts: 11 },
    { tool: "respond", initial_delay: -1 },
    { tool: "respond", initial_delay: 60001 },
  ]) {
    const result = await sidekick_retry(args);
    assert.strictEqual(result.isError, true, `invalid retry options must fail: ${JSON.stringify(args)}`);
  }

  for (const code of ["policy_denied", "approval_required", "validation_failed", "permission_denied"]) {
    let calls = 0;
    dispatcher.dispatchTool = async () => {
      calls++;
      return { isError: true, code, content: [{ type: "text", text: `${code} response` }] };
    };
    await sidekick_retry({ tool: "respond", max_attempts: 4, initial_delay: 0 });
    assert.strictEqual(calls, 1, `${code} must not be retried`);
  }

  let calls = 0;
  dispatcher.dispatchTool = async () => {
    calls++;
    return { isError: true, code: "temporary_unavailable", content: [{ type: "text", text: "temporarily unavailable" }] };
  };
  await sidekick_retry({ tool: "respond", max_attempts: 3, initial_delay: 0 });
  assert.strictEqual(calls, 3, "transient failures retain bounded retries");
}

run().then(() => console.log("Flow-control reliability tests passed"))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { dispatcher.dispatchTool = originalDispatch; });
