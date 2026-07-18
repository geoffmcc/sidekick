const { parseAgentDecision, trackDecisionRepetition, resolveAgentToolName } = require("./agent-protocol");
const { stripSidekickPrefix } = require("./core/tool-name");

const DEFAULT_MAX_ITERATIONS = 15;

function canonical(name) {
  return stripSidekickPrefix(String(name || ""));
}

function isFailureText(result) {
  return typeof result === "string" && (result.startsWith("Error:") || result.startsWith("Call failed:"));
}

// The respond tool echoes text back; it is a completion channel, not evidence
// about live system state, so it never satisfies an evidence requirement.
function isEvidenceTool(name) {
  return canonical(name) !== "respond";
}

function respondHint(getToolDefs) {
  const defs = getToolDefs() || [];
  const respond = defs.find(t => canonical(t.name) === "respond");
  return respond ? "Use " + respond.name + " to return text directly, or choose a valid tool from the list." : "Choose a valid tool from the list.";
}

/**
 * Runs the Agent Bridge planning/tool-execution loop.
 *
 * This is the security-relevant seam of the Agent tab: every tool the model
 * asks for is routed through the injected `callTool` (the real bridge passes
 * `callAgentTool`, which enforces the tool allowlist, policy, approvals, and
 * audit logging in the dispatcher). The loop itself performs no privileged
 * work — it only validates that a requested tool is visible to the agent
 * source, resolves legacy `sidekick_` aliases to the canonical catalog name,
 * forwards the call, and surfaces the structured result. Keeping it free of
 * side effects (no server, no timers) makes the tool-execution behavior
 * directly testable.
 *
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.history Seed conversation.
 * @param {(messages:Array)=>Promise<{response:string,model?:string,provider?:string,fallback?:boolean}>} opts.callLLM
 * @param {(name:string,args:object)=>Promise<{isError?:boolean,content?:Array,approvalRequired?:boolean,approvalId?:string}>} opts.callTool
 * @param {()=>Array<{name:string,enabled?:boolean}>} opts.getToolDefs Tools visible to the agent source.
 * @param {number} [opts.maxIterations]
 * @param {boolean} [opts.requireEvidence] Goal was classified as needing current
 *   evidence: a completion with zero successful evidence-tool calls gets one
 *   corrective nudge, then becomes an honest failure instead of a fabricated
 *   live-state answer.
 * @param {(event:object)=>void} [opts.emit] Progress sink (SSE in production).
 * @param {(type:string,payload:object,severity?:string)=>void} [opts.onEvent] Observability sink.
 * @param {(text:string)=>string} [opts.redact] Redaction for logged summaries.
 * @returns {Promise<{status:string,finalResult:string,terminalError:string,steps:Array,evidenceCalls:number}>}
 */
async function runToolLoop({
  history,
  callLLM,
  callTool,
  getToolDefs,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  requireEvidence = false,
  emit = () => {},
  onEvent = () => {},
  redact = (text) => text,
} = {}) {
  const steps = [];
  let status = "iteration_limit";
  let finalResult = "";
  let terminalError = "";
  let repeatState = { fingerprint: "", repeats: 0 };
  let evidenceCalls = 0;
  let evidenceNudged = false;

  const failWithoutEvidence = () => {
    status = "failed";
    terminalError = "Sidekick could not inspect the requested state: the task requires current evidence, but no inspection tool ran successfully. No answer was fabricated.";
    steps.push({ type: "error", text: terminalError });
    onEvent("agent.evidence_missing", { require_evidence: true, evidence_calls: evidenceCalls }, "error");
  };

  const nudgeForEvidence = (rawText) => {
    evidenceNudged = true;
    history.push({ role: "assistant", content: rawText.substring(0, 200) });
    history.push({
      role: "user",
      content: "This request requires current evidence from the live system. Run an appropriate tool from the list first and base your answer on its actual output. If no available tool can provide the evidence, call done stating that Sidekick could not inspect the requested state."
    });
    emit({ type: "step", text: "Answer withheld: current evidence required before completing" });
  };

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
      const message = redact("LLM error: " + e.message);
      steps.push({ type: "error", text: message });
      status = "failed";
      terminalError = message;
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

    // A parsed-but-rejected decision (forbidden keys, conflicting actions,
    // malformed tool name, done without a result) never executes. Bounded
    // corrective feedback lets the model recover; the repetition tracker and
    // iteration cap terminate persistent invalid output.
    if (decision.invalid) {
      emit({ type: "step", text: "Rejected invalid decision (" + decision.reason + ")" });
      steps.push({ type: "invalid", reason: decision.reason });
      onEvent("agent.decision_rejected", { reason: decision.reason }, "warning");
      history.push({ role: "assistant", content: text.substring(0, 200) });
      history.push({
        role: "user",
        content: "Your last output was rejected (" + decision.reason + "). Output exactly ONE valid JSON decision: {\"think\": \"...\"} OR {\"tool\": \"name\", \"arguments\": {...}} OR {\"done\": true, \"result\": \"...\"}. Do not combine them, and never use __proto__, constructor, or prototype keys."
      });
      continue;
    }

    if (decision.think) {
      emit({ type: "step", text: decision.think });
      steps.push({ type: "thought", text: decision.think });
      // Detect hallucinated tool calls in think blocks (canonical or legacy names)
      if (/called\s+(?:sidekick_)?[a-z0-9_]+\s*→/i.test(decision.think) || /stored\s+key/i.test(decision.think)) {
        history.push({ role: "assistant", content: "Thought: " + decision.think });
        history.push({ role: "user", content: "You described a tool call but did not execute it. You MUST output a tool call JSON now, not a think block." });
      } else {
        history.push({ role: "assistant", content: "Thought: " + decision.think });
      }
      continue;
    }

    if (decision.done) {
      if (requireEvidence && evidenceCalls === 0) {
        if (!evidenceNudged) {
          nudgeForEvidence(text);
          continue;
        }
        failWithoutEvidence();
        break;
      }
      const result = decision.result || "Task completed";
      steps.push({ type: "done", text: result });
      status = "completed";
      finalResult = result;
      break;
    }

    if (decision.tool) {
      // Tool validation: only tools the agent source is allowed to see may be
      // called. Legacy `sidekick_` aliases resolve to their canonical catalog
      // entry; the dispatcher independently re-validates whatever is dispatched.
      const availableToolDefs = getToolDefs();
      const resolved = resolveAgentToolName(decision.tool, availableToolDefs);
      if (!resolved) {
        const requestedLabel = String(decision.tool).substring(0, 80);
        emit({ type: "step", text: "Unknown tool: " + requestedLabel });
        steps.push({ type: "tool", tool: requestedLabel, args: decision.arguments, result: "Error: tool does not exist" });
        const availableTools = availableToolDefs.map(t => t.name).join(", ");
        history.push({ role: "assistant", content: "Called " + requestedLabel + " → Error: tool does not exist" });
        history.push({ role: "user", content: "Tool '" + requestedLabel + "' does not exist. Available tools: " + availableTools + ". " + respondHint(getToolDefs) });
        continue;
      }
      const toolName = resolved.name;

      // Deduplication check: prevent repeated identical tool calls
      const recentCalls = steps.slice(-3).filter(s => s.type === "tool" && canonical(s.tool) === resolved.canonical && JSON.stringify(s.args) === JSON.stringify(decision.arguments || {}));
      if (recentCalls.length >= 1) {
        emit({ type: "step", text: "Blocked: repeated call to " + toolName + " with same arguments" });
        history.push({ role: "assistant", content: "Called " + toolName + " → (blocked: already called)" });
        // Summarize only values that were actually retrieved successfully; a
        // blocked duplicate must never become an instruction to fabricate.
        const retrievedValues = steps
          .filter(s => s.type === "tool" && canonical(s.tool) === "get" && s.result && !isFailureText(s.result))
          .map(s => s.args.key + "=" + (s.result || "").substring(0, 50)).join(", ");
        history.push({
          role: "user",
          content: "You already called " + toolName + " with those arguments; do not repeat it." +
            (retrievedValues ? " Values you actually retrieved: " + retrievedValues + "." : "") +
            " Finish with done using only results you actually obtained, or state that the task could not be completed."
        });
        continue;
      }

      emit({ type: "tool", tool: toolName, summary: redact(JSON.stringify(decision.arguments)) });
      onEvent("agent.tool_started", { tool: toolName, requested_as: resolved.alias ? String(decision.tool).substring(0, 80) : undefined, argument_keys: Object.keys(decision.arguments || {}) });
      steps.push({ type: "tool", tool: toolName, args: decision.arguments });

      let result;
      let approvalPending = false;
      try {
        const toolRes = await callTool(toolName, decision.arguments || {});
        if (toolRes.approvalRequired) {
          approvalPending = true;
          result = "Error: " + (toolRes.content?.[0]?.text || "approval required");
        } else if (toolRes.isError) {
          result = "Error: " + (toolRes.content?.[0]?.text || "unknown error");
          // If policy or lookup blocks a tool, provide corrective feedback.
          if (result.includes("Unknown tool") || result.includes("Tool blocked by policy")) {
            const availableTools = getToolDefs().map(t => t.name).join(", ");
            result += ". Available tools: " + availableTools + ". " + respondHint(getToolDefs);
          }
        } else {
          result = toolRes.content?.[0]?.text || "(empty result)";
          if (isEvidenceTool(toolName)) evidenceCalls++;
        }
      } catch (e) {
        result = redact("Call failed: " + e.message);
      }

      const summary = result.substring(0, 500);
      emit({ type: "tool", tool: toolName, summary: summary.substring(0, 120) });
      onEvent("agent.tool_completed", { tool: toolName, ok: !isFailureText(result), summary: redact(summary).substring(0, 200) }, isFailureText(result) ? "error" : "info");
      steps[steps.length - 1].result = summary;
      history.push({ role: "assistant", content: "Called " + toolName + " → " + summary.substring(0, 200) });

      if (approvalPending) {
        // An approval-gated action stays pending: it is not retried, and its
        // absence of output must not be papered over with a fabricated answer.
        emit({ type: "step", text: "Approval required for " + toolName + "; queued for human review" });
        onEvent("agent.tool_approval_pending", { tool: toolName }, "warning");
        history.push({
          role: "user",
          content: "That action requires human approval and has been queued. Do NOT retry it and do NOT assume it ran. Continue with other tools if useful, or call done reporting that the action is awaiting approval."
        });
        continue;
      }

      // Special handling for respond: automatically transition to done
      if (resolved.canonical === "respond" && !isFailureText(result)) {
        if (requireEvidence && evidenceCalls === 0) {
          if (!evidenceNudged) {
            nudgeForEvidence(text);
            continue;
          }
          failWithoutEvidence();
          break;
        }
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

  return { status, finalResult, terminalError, steps, evidenceCalls };
}

module.exports = { runToolLoop, DEFAULT_MAX_ITERATIONS };
