const assert = require("assert");
const { runToolLoop } = require("../src/agent-loop");

console.log("Running Agent Bridge tool-loop tests...\n");

// Scripts an LLM that emits each queued decision as raw JSON, one turn at a time.
// When the script is exhausted it repeats the final decision (usually a terminal
// `done`), so the loop always converges.
function scriptedLLM(decisions, meta = {}) {
  let i = 0;
  return async () => {
    const decision = decisions[Math.min(i, decisions.length - 1)];
    i++;
    return {
      response: JSON.stringify(decision),
      model: meta.model || "test-model",
      provider: meta.provider || "test",
      fallback: meta.fallback || false,
    };
  };
}

// Records every dispatched tool call so tests can prove a tool was (or was not)
// actually invoked rather than merely described.
function recorder(impl) {
  const calls = [];
  return {
    calls,
    fn: async (name, args) => {
      calls.push({ name, args });
      return impl(name, args);
    },
  };
}

// The set of tools the agent source is allowed to see. Mirrors the shape of
// getToolDefsForSource("agent").filter(t => t.enabled).
const AGENT_TOOLS = [
  { name: "sidekick_bash", enabled: true },
  { name: "sidekick_respond", enabled: true },
  { name: "sidekick_get", enabled: true },
];
const getToolDefs = () => AGENT_TOOLS;

(async () => {
  try {
    // 1) Successful approved tool execution: the model runs an allowed tool and
    //    the *real* tool output flows back into the transcript and final answer.
    {
      const rec = recorder(async (name) =>
        name === "sidekick_bash"
          ? { content: [{ type: "text", text: "/dev/sda1  23% /" }] }
          : { content: [{ type: "text", text: "ok" }] }
      );
      const emitted = [];
      const events = [];
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "sidekick_bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk usage is 23%." },
        ]),
        callTool: rec.fn,
        getToolDefs,
        emit: (event) => emitted.push(event),
        onEvent: (type, payload, severity) => events.push({ type, payload, severity }),
      });

      assert.strictEqual(result.status, "completed", "approved tool run should complete");
      assert.strictEqual(result.finalResult, "Disk usage is 23%.");
      assert.strictEqual(rec.calls.length, 1, "the approved tool must actually be dispatched");
      assert.deepStrictEqual(rec.calls[0], { name: "sidekick_bash", args: { command: "df -h" } });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep && toolStep.result.includes("/dev/sda1"), "real tool output must appear in the transcript");
      // Observability/audit hooks must still fire around dispatch.
      assert.ok(events.some((e) => e.type === "agent.tool_started"), "tool_started event should fire");
      assert.ok(events.some((e) => e.type === "agent.tool_completed" && e.payload.ok === true), "tool_completed event should fire");
      assert.ok(emitted.some((e) => e.type === "tool"), "a tool progress event should be streamed");
    }

    // 2) Denied / unauthorized tool: dispatch still happens (so the central
    //    approval/policy layer decides), and the denial is surfaced verbatim
    //    to the agent instead of crashing the loop.
    {
      const rec = recorder(async () => ({
        isError: true,
        content: [{ type: "text", text: "Approval required: sidekick_bash (high risk). Queued as appr_1." }],
      }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "restart the service" }],
        callLLM: scriptedLLM([
          { tool: "sidekick_bash", arguments: { command: "systemctl restart x" } },
          { done: true, result: "Restart requested; approval pending." },
        ]),
        callTool: rec.fn,
        getToolDefs,
      });
      assert.strictEqual(rec.calls.length, 1, "denied tool is still dispatched so approval is enforced centrally");
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.startsWith("Error: Approval required"), "approval requirement must be surfaced");
      assert.strictEqual(result.status, "completed", "loop keeps control after a denial");
    }

    // 2b) Policy-blocked tool: surfaced as an error plus corrective tool guidance.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "do a blocked thing" }],
        callLLM: scriptedLLM([
          { tool: "sidekick_bash", arguments: {} },
          { done: true, result: "Could not run the blocked tool." },
        ]),
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "Tool blocked by policy" }] }),
        getToolDefs,
      });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.includes("Tool blocked by policy"), "policy denial text must be surfaced");
      assert.ok(toolStep.result.includes("Available tools:"), "policy denial should include corrective tool guidance");
    }

    // 3) Unavailable tool: a tool not visible to the agent source is rejected
    //    before dispatch — it must never reach callTool.
    {
      const rec = recorder(async () => ({ content: [{ type: "text", text: "should not run" }] }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "use a made-up tool" }],
        callLLM: scriptedLLM([
          { tool: "sidekick_nonexistent", arguments: {} },
          { done: true, result: "No such tool." },
        ]),
        callTool: rec.fn,
        getToolDefs,
      });
      assert.strictEqual(rec.calls.length, 0, "unavailable tools must never reach dispatch");
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.strictEqual(toolStep.result, "Error: tool does not exist");
    }

    // 4a) Tool execution failure (structured error from the handler).
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "sidekick_bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk check failed." },
        ]),
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "df: command not found" }] }),
        getToolDefs,
      });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.startsWith("Error: df: command not found"), "handler errors must be surfaced");
    }

    // 4b) Tool execution failure (handler throws) — surfaced as a call failure,
    //     and the loop retains control instead of aborting the whole task.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "sidekick_bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk check failed." },
        ]),
        callTool: async () => { throw new Error("socket hang up"); },
        getToolDefs,
      });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.startsWith("Call failed: socket hang up"), "thrown errors must be caught and surfaced");
      assert.strictEqual(result.status, "completed");
    }

    // 5) Requests that should not invoke tools: when the model answers directly,
    //    no tool is dispatched and the answer is returned as-is.
    {
      const rec = recorder(async () => ({ content: [{ type: "text", text: "x" }] }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "say hi" }],
        callLLM: scriptedLLM([{ done: true, result: "Hi." }]),
        callTool: rec.fn,
        getToolDefs,
      });
      assert.strictEqual(rec.calls.length, 0, "a direct answer must not invoke tools");
      assert.strictEqual(result.finalResult, "Hi.");
      assert.strictEqual(result.status, "completed");
    }

    // sidekick_respond returns text directly and auto-completes the task.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "respond hello" }],
        callLLM: scriptedLLM([{ tool: "sidekick_respond", arguments: { text: "Hello" } }]),
        callTool: async () => ({ content: [{ type: "text", text: "Hello" }] }),
        getToolDefs,
      });
      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.finalResult, "Hello");
    }

    // LLM/provider failure aborts the task with a clear terminal error.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: async () => { throw new Error("provider unavailable"); },
        callTool: async () => ({ content: [{ type: "text", text: "x" }] }),
        getToolDefs,
      });
      assert.strictEqual(result.status, "failed");
      assert.ok(result.terminalError.startsWith("LLM error: provider unavailable"));
    }

    console.log("Agent Bridge tool-loop tests passed");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
