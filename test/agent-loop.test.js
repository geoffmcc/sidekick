const assert = require("assert");
const { runToolLoop } = require("../src/agent-loop");

console.log("Running Agent Bridge tool-loop tests...\n");

// Scripts an LLM that emits each queued decision, one turn at a time. A string
// entry is emitted verbatim (for malformed/adversarial payloads); anything else
// is JSON-stringified. When the script is exhausted it repeats the final
// decision (usually a terminal `done`), so the loop always converges.
function scriptedLLM(decisions, meta = {}) {
  let i = 0;
  return async () => {
    const decision = decisions[Math.min(i, decisions.length - 1)];
    i++;
    return {
      response: typeof decision === "string" ? decision : JSON.stringify(decision),
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
// getToolDefsForSource("agent").filter(t => t.enabled): since the canonical
// naming refactor the production catalog uses UNPREFIXED names.
const AGENT_TOOLS = [
  { name: "bash", enabled: true },
  { name: "respond", enabled: true },
  { name: "get", enabled: true },
];
const getToolDefs = () => AGENT_TOOLS;

(async () => {
  try {
    // 1) Successful approved tool execution: the model runs an allowed tool and
    //    the *real* tool output flows back into the transcript and final answer.
    {
      const rec = recorder(async (name) =>
        name === "bash"
          ? { content: [{ type: "text", text: "/dev/sda1  23% /" }] }
          : { content: [{ type: "text", text: "ok" }] }
      );
      const emitted = [];
      const events = [];
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "bash", arguments: { command: "df -h" } },
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
      assert.deepStrictEqual(rec.calls[0], { name: "bash", args: { command: "df -h" } });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep && toolStep.result.includes("/dev/sda1"), "real tool output must appear in the transcript");
      assert.strictEqual(result.evidenceCalls, 1, "a successful non-respond tool call counts as evidence");
      // Observability/audit hooks must still fire around dispatch.
      assert.ok(events.some((e) => e.type === "agent.tool_started"), "tool_started event should fire");
      assert.ok(events.some((e) => e.type === "agent.tool_completed" && e.payload.ok === true), "tool_completed event should fire");
      assert.ok(emitted.some((e) => e.type === "tool"), "a tool progress event should be streamed");
    }

    // 1b) Legacy alias compatibility: a model still speaking the pre-rename
    //     `sidekick_` dialect resolves to the canonical catalog entry and the
    //     CANONICAL name is dispatched (single normalization point).
    {
      const rec = recorder(async () => ({ content: [{ type: "text", text: "/dev/sda1  23% /" }] }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "sidekick_bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk usage is 23%." },
        ]),
        callTool: rec.fn,
        getToolDefs,
      });
      assert.strictEqual(result.status, "completed", "legacy alias must keep working");
      assert.strictEqual(rec.calls.length, 1, "aliased tool must actually be dispatched");
      assert.strictEqual(rec.calls[0].name, "bash", "canonical name must be dispatched, not the alias");
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.strictEqual(toolStep.tool, "bash", "transcript records the canonical name");
    }

    // 2) Approval-gated tool: dispatch still happens (so the central approval
    //    layer decides), the pending state is surfaced, the call is not
    //    retried, and no fabricated completion is produced.
    {
      const rec = recorder(async () => ({
        isError: true,
        approvalRequired: true,
        approvalId: "appr_1",
        content: [{ type: "text", text: "Approval required: bash (high risk). Queued as appr_1." }],
      }));
      const emitted = [];
      const events = [];
      const result = await runToolLoop({
        history: [{ role: "user", content: "restart the service" }],
        callLLM: scriptedLLM([
          { tool: "bash", arguments: { command: "systemctl restart x" } },
          { done: true, result: "Restart requested; approval pending." },
        ]),
        callTool: rec.fn,
        getToolDefs,
        emit: (event) => emitted.push(event),
        onEvent: (type, payload, severity) => events.push({ type, payload, severity }),
      });
      assert.strictEqual(rec.calls.length, 1, "approval-gated tool is still dispatched so approval is enforced centrally");
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.startsWith("Error: Approval required"), "approval requirement must be surfaced");
      assert.ok(events.some((e) => e.type === "agent.tool_approval_pending"), "approval-pending event should fire");
      assert.ok(emitted.some((e) => e.type === "step" && /Approval required/.test(e.text)), "approval-pending step streamed");
      assert.strictEqual(result.status, "completed", "loop keeps control after an approval gate");
      assert.strictEqual(result.evidenceCalls, 0, "an approval-pending call is not evidence");
    }

    // 2b) Policy-blocked tool: surfaced as an error plus corrective tool guidance.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "do a blocked thing" }],
        callLLM: scriptedLLM([
          { tool: "bash", arguments: {} },
          { done: true, result: "Could not run the blocked tool." },
        ]),
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "Tool blocked by policy" }] }),
        getToolDefs,
      });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.includes("Tool blocked by policy"), "policy denial text must be surfaced");
      assert.ok(toolStep.result.includes("Available tools:"), "policy denial should include corrective tool guidance");
      assert.ok(toolStep.result.includes("respond"), "corrective guidance names the real respond tool");
      assert.ok(!toolStep.result.includes("sidekick_respond"), "corrective guidance must not teach a stale name");
    }

    // 3) Unavailable tool: a tool not visible to the agent source is rejected
    //    before dispatch — it must never reach callTool. Applies to unknown
    //    canonical names AND unknown legacy-alias names.
    {
      for (const name of ["nonexistent_tool", "sidekick_nonexistent"]) {
        const rec = recorder(async () => ({ content: [{ type: "text", text: "should not run" }] }));
        const result = await runToolLoop({
          history: [{ role: "user", content: "use a made-up tool" }],
          callLLM: scriptedLLM([
            { tool: name, arguments: {} },
            { done: true, result: "No such tool." },
          ]),
          callTool: rec.fn,
          getToolDefs,
        });
        assert.strictEqual(rec.calls.length, 0, "unavailable tools must never reach dispatch: " + name);
        const toolStep = result.steps.find((s) => s.type === "tool");
        assert.strictEqual(toolStep.result, "Error: tool does not exist");
      }
    }

    // 3b) Disabled / source-denied tool: not present in the visible defs (the
    //     bridge filters on enabled + source policy upstream), so it is
    //     rejected before dispatch even though the tool exists elsewhere.
    {
      const rec = recorder(async () => ({ content: [{ type: "text", text: "should not run" }] }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "use a denied tool" }],
        callLLM: scriptedLLM([
          { tool: "service", arguments: {} },
          { done: true, result: "Tool denied." },
        ]),
        callTool: rec.fn,
        getToolDefs, // catalog does not contain "service"
      });
      assert.strictEqual(rec.calls.length, 0, "source-denied tools must never reach dispatch");
    }

    // 3c) Malformed / adversarial tool names never execute and never crash:
    //     prototype-chain shapes, empty-after-prefix, unicode, oversized.
    {
      const bad = ["__proto__", "constructor", "sidekick___proto__", "sidekick_", "Bash", "bäsh", "x".repeat(500)];
      for (const name of bad) {
        const rec = recorder(async () => ({ content: [{ type: "text", text: "should not run" }] }));
        const result = await runToolLoop({
          history: [{ role: "user", content: "adversarial name" }],
          callLLM: scriptedLLM([
            { tool: name, arguments: {} },
            { done: true, result: "Rejected." },
          ]),
          callTool: rec.fn,
          getToolDefs,
        });
        assert.strictEqual(rec.calls.length, 0, "malformed tool name must never dispatch: " + JSON.stringify(name));
        assert.strictEqual(result.status, "completed", "loop must survive malformed names: " + JSON.stringify(name));
      }
    }

    // 3d) Prototype-pollution-shaped decisions are rejected without executing,
    //     and Object.prototype stays clean. Raw JSON strings are used so the
    //     test itself cannot be tricked by object-literal __proto__ semantics.
    {
      const payloads = [
        '{"tool": "get", "__proto__": {"polluted": true}, "key": "x"}',
        '{"tool": "bash", "arguments": {"__proto__": {"polluted": true}}}',
        '{"tool": "bash", "constructor": {"prototype": {"polluted": true}}, "command": "id"}',
      ];
      for (const payload of payloads) {
        const rec = recorder(async () => ({ content: [{ type: "text", text: "should not run" }] }));
        const result = await runToolLoop({
          history: [{ role: "user", content: "pollution attempt" }],
          callLLM: scriptedLLM([payload, { done: true, result: "Rejected." }]),
          callTool: rec.fn,
          getToolDefs,
        });
        assert.strictEqual(rec.calls.length, 0, "forbidden-key decision must never dispatch");
        assert.ok(result.steps.some((s) => s.type === "invalid" && s.reason === "forbidden_key"), "rejection is recorded");
        assert.strictEqual(({}).polluted, undefined, "Object.prototype must remain unpolluted");
      }
    }

    // 3e) Conflicting multi-action decisions do not execute and do not complete.
    {
      const rec = recorder(async () => ({ content: [{ type: "text", text: "should not run" }] }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "conflict" }],
        callLLM: scriptedLLM([
          { tool: "respond", done: true, result: "fake", arguments: { text: "fake" } },
          { done: true, result: "Recovered." },
        ]),
        callTool: rec.fn,
        getToolDefs,
      });
      assert.strictEqual(rec.calls.length, 0, "conflicting decision must not execute");
      assert.ok(result.steps.some((s) => s.type === "invalid" && s.reason === "conflicting_actions"));
      assert.strictEqual(result.finalResult, "Recovered.", "bounded corrective feedback lets the model recover");
    }

    // 3f) done without a usable result is rejected (an empty result must never
    //     become a claimed success), and persistent invalid output terminates
    //     within the bounded repetition limit.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "finish" }],
        callLLM: scriptedLLM([{ done: true }]),
        callTool: async () => ({ content: [{ type: "text", text: "x" }] }),
        getToolDefs,
      });
      assert.strictEqual(result.status, "failed", "persistent invalid decisions must terminate as failure");
      assert.ok(result.steps.some((s) => s.type === "invalid" && s.reason === "done_without_result"));
      assert.ok(result.steps.length < 10, "terminates well within the iteration budget");
    }

    // 4a) Tool execution failure (structured error from the handler).
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk check failed." },
        ]),
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "df: command not found" }] }),
        getToolDefs,
      });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.startsWith("Error: df: command not found"), "handler errors must be surfaced");
      assert.strictEqual(result.evidenceCalls, 0, "a failed tool call is not evidence");
    }

    // 4b) Tool execution failure (handler throws) — surfaced as a redacted call
    //     failure, and the loop retains control instead of aborting the task.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk check failed." },
        ]),
        callTool: async () => { throw new Error("socket hang up token=hunter2"); },
        getToolDefs,
        redact: (text) => text.replace(/hunter2/g, "[REDACTED]"),
      });
      const toolStep = result.steps.find((s) => s.type === "tool");
      assert.ok(toolStep.result.startsWith("Call failed: socket hang up"), "thrown errors must be caught and surfaced");
      assert.ok(!toolStep.result.includes("hunter2"), "thrown error text must pass through redaction");
      assert.strictEqual(result.status, "completed");
    }

    // 4c) Streamed tool arguments are redacted before they reach the SSE sink.
    {
      const emitted = [];
      await runToolLoop({
        history: [{ role: "user", content: "store a secret" }],
        callLLM: scriptedLLM([
          { tool: "get", arguments: { key: "k", password: "hunter2" } },
          { done: true, result: "done" },
        ]),
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        getToolDefs,
        emit: (event) => emitted.push(event),
        redact: (text) => text.replace(/hunter2/g, "[REDACTED]"),
      });
      const argEvents = emitted.filter((e) => e.type === "tool" && e.summary);
      assert.ok(argEvents.length > 0, "tool events streamed");
      assert.ok(argEvents.every((e) => !String(e.summary).includes("hunter2")), "streamed args must be redacted");
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

    // 6) respond returns text directly and auto-completes — canonical name and
    //    legacy alias both keep the auto-done behavior.
    {
      for (const name of ["respond", "sidekick_respond"]) {
        const result = await runToolLoop({
          history: [{ role: "user", content: "respond hello" }],
          callLLM: scriptedLLM([{ tool: name, arguments: { text: "Hello" } }]),
          callTool: async () => ({ content: [{ type: "text", text: "Hello" }] }),
          getToolDefs,
        });
        assert.strictEqual(result.status, "completed", "respond auto-done for " + name);
        assert.strictEqual(result.finalResult, "Hello");
      }
    }

    // 7) Evidence requirement: an evidence-required task that tries to finish
    //    without any successful inspection tool gets one corrective nudge; if
    //    the model recovers and runs a tool, the task completes on evidence.
    {
      const rec = recorder(async () => ({ content: [{ type: "text", text: "/dev/sda1 23%" }] }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { done: true, result: "You can run df -h to check disk usage." },
          { tool: "bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk usage is 23% (from df)." },
        ]),
        callTool: rec.fn,
        getToolDefs,
        requireEvidence: true,
      });
      assert.strictEqual(result.status, "completed");
      assert.strictEqual(rec.calls.length, 1, "the nudge must lead to a real tool call");
      assert.strictEqual(result.finalResult, "Disk usage is 23% (from df).");
    }

    // 7b) Evidence requirement, unrecoverable: a model that keeps answering
    //     without evidence produces an honest failure — never a fabricated
    //     instruction-style answer presented as current state.
    {
      const rec = recorder(async () => ({ content: [{ type: "text", text: "x" }] }));
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { done: true, result: "You can run df -h yourself." },
          { done: true, result: "Just run df -h in a terminal." },
        ]),
        callTool: rec.fn,
        getToolDefs,
        requireEvidence: true,
      });
      assert.strictEqual(result.status, "failed", "evidence-free completion must fail honestly");
      assert.ok(/could not inspect/.test(result.terminalError), "failure names the missing inspection");
      assert.strictEqual(result.finalResult, "", "no fabricated final answer");
      assert.strictEqual(rec.calls.length, 0);
    }

    // 7c) Evidence requirement also applies to respond-only completions: the
    //     respond echo channel is not evidence about live state.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "respond", arguments: { text: "Disk is probably fine." } },
          { tool: "respond", arguments: { text: "Disk looks okay to me." } },
        ]),
        callTool: async () => ({ content: [{ type: "text", text: "echo" }] }),
        getToolDefs,
        requireEvidence: true,
      });
      assert.strictEqual(result.status, "failed", "respond-only cannot satisfy an evidence requirement");
      assert.ok(/could not inspect/.test(result.terminalError));
    }

    // 7d) A failed tool call does not satisfy the evidence requirement — the
    //     failure must not silently become a confident answer.
    {
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk usage is 23%." },
          { done: true, result: "Disk usage is 23%." },
        ]),
        callTool: async () => ({ isError: true, content: [{ type: "text", text: "df: not found" }] }),
        getToolDefs,
        requireEvidence: true,
      });
      assert.strictEqual(result.status, "failed", "failed evidence collection must not complete as fact");
    }

    // 8) Duplicate-call feedback is honest: it must not command fabrication and
    //    must not present error output as retrieved data. The duplicate uses the
    //    legacy alias to prove dedup is canonical-name aware (an identical
    //    verbatim repeat is already caught earlier by the repetition tracker).
    {
      const history = [{ role: "user", content: "get the same key twice" }];
      await runToolLoop({
        history,
        callLLM: scriptedLLM([
          { tool: "get", arguments: { key: "a" } },
          { tool: "sidekick_get", arguments: { key: "a" } },
          { done: true, result: "a=1" },
        ]),
        callTool: async () => ({ content: [{ type: "text", text: "1" }] }),
        getToolDefs,
      });
      const dupFeedback = history.filter((m) => m.role === "user").map((m) => m.content).find((c) => c.includes("do not repeat it"));
      assert.ok(dupFeedback, "duplicate call produces corrective feedback");
      assert.ok(!/Call done NOW/.test(dupFeedback), "feedback must not command immediate fabricated completion");
      assert.ok(dupFeedback.includes("a=1"), "successfully retrieved values may be restated");
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

    // Provider fallback metadata still streams (decision contract is provider-
    // independent: same parser/validation regardless of which provider ran).
    {
      const emitted = [];
      const result = await runToolLoop({
        history: [{ role: "user", content: "check disk usage" }],
        callLLM: scriptedLLM([
          { tool: "bash", arguments: { command: "df -h" } },
          { done: true, result: "Disk usage is 23%." },
        ], { provider: "groq", fallback: true }),
        callTool: async () => ({ content: [{ type: "text", text: "/dev/sda1 23%" }] }),
        getToolDefs,
        emit: (event) => emitted.push(event),
      });
      assert.strictEqual(result.status, "completed");
      assert.ok(emitted.some((e) => e.type === "fallback"), "fallback event streamed");
      assert.ok(emitted.some((e) => e.type === "provider" && e.name === "groq"), "provider event streamed");
    }

    console.log("Agent Bridge tool-loop tests passed");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
