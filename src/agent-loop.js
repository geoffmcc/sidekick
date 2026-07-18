const { parseAgentDecision, trackDecisionRepetition } = require("./agent-protocol");

const DEFAULT_MAX_ITERATIONS = 15;

/**
 * Runs the Agent Bridge planning/tool-execution loop.
 *
 * This is the security-relevant seam of the Agent tab: every tool the model
 * asks for is routed through the injected `callTool` (the real bridge passes
 * `callAgentTool`, which enforces the tool allowlist, policy, approvals, and
 * audit logging in the dispatcher). The loop itself performs no privileged
 * work — it only validates that a requested tool is visible to the agent
 * source, forwards the call, and surfaces the structured result. Keeping it
 * free of side effects (no server, no timers) makes the tool-execution
 * behavior directly testable.
 *
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.history Seed conversation.
 * @param {(messages:Array)=>Promise<{response:string,model?:string,provider?:string,fallback?:boolean}>} opts.callLLM
 * @param {(name:string,args:object)=>Promise<{isError?:boolean,content?:Array}>} opts.callTool
 * @param {()=>Array<{name:string,enabled?:boolean}>} opts.getToolDefs Tools visible to the agent source.
 * @param {number} [opts.maxIterations]
 * @param {(event:object)=>void} [opts.emit] Progress sink (SSE in production).
 * @param {(type:string,payload:object,severity?:string)=>void} [opts.onEvent] Observability sink.
 * @param {(text:string)=>string} [opts.redact] Redaction for logged summaries.
 * @returns {Promise<{status:string,finalResult:string,terminalError:string,steps:Array}>}
 */
async function runToolLoop({
  history,
  callLLM,
  callTool,
  getToolDefs,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  emit = () => {},
  onEvent = () => {},
  redact = (text) => text,
} = {}) {
  const steps = [];
  let status = "iteration_limit";
  let finalResult = "";
  let terminalError = "";
  let repeatState = { fingerprint: "", repeats: 0 };

  for (let i = 0; i < maxIterations; i++) {
    let response;
    try {
      response = await callLLM(history);
      if (i === 0) {
        emit({ type: "provider", name: response.provider, model: response.model || "unknown" });
      }
      if (response.fallback) {
        emit({ type: "fallback", from: "ollama", to: "groq" });
      }
    } catch (e) {
      steps.push({ type: "error", text: e.message });
      status = "failed";
      terminalError = "LLM error: " + e.message;
      break;
    }

    const text = (response.response || "").trim();
    const decision = parseAgentDecision(text);
    repeatState = trackDecisionRepetition(repeatState, decision);

    if (repeatState.repeated) {
      if (repeatState.abort) {
        status = "failed";
        terminalError = "Agent stopped after repeating the same decision three times";
        steps.push({ type: "error", text: terminalError });
        break;
      }
      history.push({ role: "assistant", content: text });
      history.push({
        role: "user",
        content: "You repeated the same decision. Do not restate it. Output one valid tool call or a done result as raw JSON now."
      });
      continue;
    }

    if (decision.think) {
      emit({ type: "step", text: decision.think });
      steps.push({ type: "thought", text: decision.think });
      // Detect hallucinated tool calls in think blocks
      if (/called\s+sidekick_\w+\s*→/i.test(decision.think) || /stored\s+key/i.test(decision.think)) {
        history.push({ role: "assistant", content: "Thought: " + decision.think });
        history.push({ role: "user", content: "You described a tool call but did not execute it. You MUST output a tool call JSON now, not a think block." });
      } else {
        history.push({ role: "assistant", content: "Thought: " + decision.think });
      }
      continue;
    }

    if (decision.done) {
      const result = decision.result || "Task completed";
      steps.push({ type: "done", text: result });
      status = "completed";
      finalResult = result;
      break;
    }

    if (decision.tool) {
      // Tool validation: only tools the agent source is allowed to see may be called.
      const availableToolDefs = getToolDefs();
      const validTool = availableToolDefs.find(t => t.name === decision.tool);
      if (!validTool) {
        emit({ type: "step", text: "Unknown tool: " + decision.tool });
        steps.push({ type: "tool", tool: decision.tool, args: decision.arguments, result: "Error: tool does not exist" });
        const availableTools = availableToolDefs.map(t => t.name).join(", ");
        history.push({ role: "assistant", content: "Called " + decision.tool + " → Error: tool does not exist" });
        history.push({ role: "user", content: "Tool '" + decision.tool + "' does not exist. Available tools: " + availableTools + ". Use sidekick_respond to return text directly, or choose a valid tool from the list." });
        continue;
      }

      // Deduplication check: prevent repeated identical tool calls
      const recentCalls = steps.slice(-3).filter(s => s.type === "tool" && s.tool === decision.tool && JSON.stringify(s.args) === JSON.stringify(decision.arguments || {}));
      if (recentCalls.length >= 1) {
        emit({ type: "step", text: "Blocked: repeated call to " + decision.tool + " with same arguments" });
        history.push({ role: "assistant", content: "Called " + decision.tool + " → (blocked: already called)" });
        // Collect all retrieved values from previous get calls
        const retrievedValues = steps.filter(s => s.type === "tool" && s.tool === "sidekick_get").map(s => s.args.key + "=" + (s.result || "").substring(0, 50)).join(", ");
        history.push({ role: "user", content: "You already have all the data. Call done NOW with this result: " + retrievedValues + ". Do NOT call any more tools." });
        continue;
      }

      emit({ type: "tool", tool: decision.tool, summary: JSON.stringify(decision.arguments) });
      onEvent("agent.tool_started", { tool: decision.tool, argument_keys: Object.keys(decision.arguments || {}) });
      steps.push({ type: "tool", tool: decision.tool, args: decision.arguments });

      let result;
      try {
        const toolRes = await callTool(decision.tool, decision.arguments || {});
        if (toolRes.isError) {
          result = "Error: " + (toolRes.content?.[0]?.text || "unknown error");
          // If policy or lookup blocks a tool, provide corrective feedback.
          if (result.includes("Unknown tool") || result.includes("Tool blocked by policy")) {
            const availableTools = getToolDefs().map(t => t.name).join(", ");
            result += ". Available tools: " + availableTools + ". Use sidekick_respond to return text directly.";
          }
        } else {
          result = toolRes.content?.[0]?.text || "(empty result)";
        }
      } catch (e) {
        result = "Call failed: " + e.message;
      }

      const summary = result.substring(0, 500);
      emit({ type: "tool", tool: decision.tool, summary: summary.substring(0, 120) });
      onEvent("agent.tool_completed", { tool: decision.tool, ok: !result.startsWith("Error:") && !result.startsWith("Call failed:"), summary: redact(summary).substring(0, 200) }, result.startsWith("Error:") || result.startsWith("Call failed:") ? "error" : "info");
      steps[steps.length - 1].result = summary;
      history.push({ role: "assistant", content: "Called " + decision.tool + " → " + summary.substring(0, 200) });

      // Special handling for sidekick_respond: automatically transition to done
      if (decision.tool === "sidekick_respond" && !result.startsWith("Error:")) {
        steps.push({ type: "done", text: result });
        status = "completed";
        finalResult = result;
        break;
      }

      history.push({ role: "user", content: "Continue. Use another tool or call done." });
    }
  }

  if (status === "iteration_limit") {
    terminalError = `Agent stopped after ${maxIterations} iterations without a final answer`;
    steps.push({ type: "error", text: terminalError });
  }

  return { status, finalResult, terminalError, steps };
}

module.exports = { runToolLoop, DEFAULT_MAX_ITERATIONS };
