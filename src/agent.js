require("./env");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");
const { execFileSync } = require("child_process");
const { callTool, DATA_DIR, GROQ_API_KEY, GROQ_MODEL, setSource, loadDelays, saveDelays, loadWatches, saveWatches, getToolDefsForSource, transitionScheduledPlatformExecution, appendScheduledPlatformEvent, createScheduledPlatformExecution } = require("./tools");
const { recallMemoryForTextAsync, formatMemoryRecall, recordAgentTaskMemory, buildMemoryBrief, inferProjectFromText } = require("./memory");
const { parseAgentDecision, trackDecisionRepetition, selectBestModelName, buildChatMessages, requiresToolUse } = require("./agent-protocol");
const platformKernel = require("./platform/kernel");
const { redactSensitive } = require("./redact");
let inferenceService = null;
try { inferenceService = require("./compute/inference-service"); } catch {}

const PORT = parseInt(process.env.SIDEKICK_AGENT_PORT || "4099", 10);

const MAX_ITERATIONS = parseInt(process.env.SIDEKICK_MAX_ITERATIONS || "15", 10);
const CONV_DIR = path.join(DATA_DIR, "conversations");
fs.mkdirSync(CONV_DIR, { recursive: true });

try {
  const cutoff = Date.now() - (30 * 86400000);
  fs.readdirSync(CONV_DIR).filter(f => f.endsWith(".json")).forEach(f => {
    const p = path.join(CONV_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  });
} catch (e) {}

const delayTimers = {};

function scheduleDelay(delay) {
  const executeAt = new Date(delay.when).getTime();
  const msUntil = executeAt - Date.now();
  
  if (msUntil <= 0) {
    executeDelay(delay);
    return;
  }
  
  delayTimers[delay.id] = setTimeout(() => {
    executeDelay(delay);
  }, msUntil);
  
  console.log(`Scheduled delay ${delay.id} for ${delay.when} (${Math.round(msUntil / 60000)} minutes)`);
}

async function executeDelay(delay) {
  const delays = loadDelays();
  const current = delays.find(d => d.id === delay.id);
  
  if (!current || current.status !== "pending") {
    delete delayTimers[delay.id];
    return;
  }
  
  current.status = "running";
  current.startedAt = new Date().toISOString();
  transitionScheduledPlatformExecution("delay", current, "running", { source: "agent", actor: "agent", reason: "scheduled delay execution started" });
  saveDelays(delays);
  
  console.log(`Executing delay ${delay.id}: ${delay.tool}`);
  
  try {
    const result = await callTool(delay.tool, delay.args || {}, {
      parentId: current.platform_execution_id || null,
      rootExecutionId: current.platform_execution_id || null,
      correlationId: delay.id,
    });
    const delaysAfter = loadDelays();
    const updated = delaysAfter.find(d => d.id === delay.id);
    if (updated) {
      updated.status = result.isError ? "failed" : "completed";
      updated.completedAt = new Date().toISOString();
      updated.result = result.content?.[0]?.text?.substring(0, 200) || "ok";
      transitionScheduledPlatformExecution("delay", updated, result.isError ? "failed" : "completed", {
        source: "agent",
        actor: "agent",
        reason: result.isError ? "scheduled delay execution failed" : "scheduled delay execution completed",
        result_status: result.isError ? "failure" : "success",
        result_summary: updated.result,
      });
      appendScheduledPlatformEvent("delay", updated, result.isError ? "schedule.delay.failed" : "schedule.delay.completed", { completed_at: updated.completedAt }, { source: "agent", actor: "agent", severity: result.isError ? "error" : "info" });
      saveDelays(delaysAfter);
    }
    console.log(`Delay ${delay.id} completed`);
  } catch (e) {
    const delaysAfter = loadDelays();
    const updated = delaysAfter.find(d => d.id === delay.id);
    if (updated) {
      updated.status = "failed";
      updated.completedAt = new Date().toISOString();
      updated.error = e.message;
      transitionScheduledPlatformExecution("delay", updated, "failed", {
        source: "agent",
        actor: "agent",
        reason: "scheduled delay execution threw",
        result_status: "failure",
        result_summary: e.message,
      });
      appendScheduledPlatformEvent("delay", updated, "schedule.delay.failed", { error: e.message }, { source: "agent", actor: "agent", severity: "error" });
      saveDelays(delaysAfter);
    }
    console.error(`Delay ${delay.id} failed: ${e.message}`);
  }
  
  delete delayTimers[delay.id];
}

function loadAndScheduleDelays() {
  const delays = loadDelays();
  const pending = delays.filter(d => d.status === "pending");
  
  for (const delay of pending) {
    scheduleDelay(delay);
  }
  
  console.log(`Loaded ${pending.length} pending delays`);
}

loadAndScheduleDelays();

const watchIntervals = {};

function parseWatchInterval(interval) {
  if (!interval) return 60000;
  const match = interval.match(/^(\d+)(s|m|h)$/);
  if (!match) return 60000;
  const amount = parseInt(match[1]);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000 };
  return amount * multipliers[unit];
}

function checkService(serviceName) {
  try {
    const output = execFileSync("systemctl", ["is-active", serviceName], { encoding: "utf-8", timeout: 5000 }).trim();
    return { status: output, active: output === "active" };
  } catch {
    return { status: "unknown", active: false };
  }
}

function checkProcess(processName) {
  try {
    const output = execFileSync("pgrep", ["-f", processName], { encoding: "utf-8", timeout: 5000 }).trim();
    return { running: output.length > 0, pids: output.split("\n").filter(Boolean) };
  } catch {
    return { running: false, pids: [] };
  }
}

function checkEndpoint(url) {
  try {
    const output = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url], { encoding: "utf-8", timeout: 10000 }).trim();
    return { status: parseInt(output), ok: output.startsWith("2") };
  } catch {
    return { status: 0, ok: false };
  }
}

function checkFile(filePath, pattern) {
  try {
    const output = fs.readFileSync(filePath, "utf-8");
    const matches = pattern ? output.includes(pattern) : true;
    return { exists: true, matches, content: output.substring(0, 200) };
  } catch {
    return { exists: false, matches: false };
  }
}

function evaluateWatchCondition(watch, checkResult) {
  const { source, condition, value } = watch;
  
  if (source === "service") {
    if (condition === "status!=active") return !checkResult.active;
    if (condition === "status=active") return checkResult.active;
  }
  
  if (source === "process") {
    if (condition === "not_running") return !checkResult.running;
    if (condition === "running") return checkResult.running;
  }
  
  if (source === "endpoint") {
    if (condition === "status!=200") return checkResult.status !== 200;
    if (condition === "status=200") return checkResult.status === 200;
    if (condition.startsWith("status>=")) {
      const threshold = parseInt(condition.substring(8));
      return checkResult.status >= threshold;
    }
  }
  
  if (source === "file") {
    if (condition === "content_matches") return checkResult.exists && checkResult.matches;
    if (condition === "not_exists") return !checkResult.exists;
    if (condition === "exists") return checkResult.exists;
  }
  
  return false;
}

async function executeWatchAction(watch, checkResult, metadata = {}) {
  const { action_tool, action_args } = watch;
  if (!action_tool) return;
  
  const args = { ...action_args };
  if (args.message) {
    args.message = args.message
      .replace(/\{\{source\}\}/g, watch.source)
      .replace(/\{\{target\}\}/g, watch.target)
      .replace(/\{\{status\}\}/g, JSON.stringify(checkResult))
      .replace(/\{\{time\}\}/g, new Date().toISOString());
  }
  
  try {
    return await callTool(action_tool, args, metadata);
  } catch (e) {
    console.error(`Watch ${watch.id} action failed: ${e.message}`);
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function checkWatch(watch) {
  const watches = loadWatches();
  const current = watches.find(w => w.id === watch.id);
  
  if (!current || current.status !== "active") {
    return;
  }
  
  let checkResult;
  if (watch.source === "service") {
    checkResult = checkService(watch.target);
  } else if (watch.source === "process") {
    checkResult = checkProcess(watch.target);
  } else if (watch.source === "endpoint") {
    checkResult = checkEndpoint(watch.target);
  } else if (watch.source === "file") {
    checkResult = checkFile(watch.target, watch.condition === "content_matches" ? watch.value : null);
  }
  
  const triggered = evaluateWatchCondition(watch, checkResult);
  const checkExecution = createScheduledPlatformExecution("watch", watch, {
    attach: false,
    parentExecutionId: watch.platform_execution_id || null,
    rootExecutionId: watch.platform_execution_id || null,
    operationType: "watch_check",
    state: "running",
    source: "agent",
    actor: "agent",
    risk: "medium",
    metadata: { source: watch.source, target: watch.target, condition: watch.condition },
    reason: "scheduled watch check started",
  });
  
  const watchesAfter = loadWatches();
  const updated = watchesAfter.find(w => w.id === watch.id);
  if (updated) {
    updated.lastCheck = new Date().toISOString();
    if (triggered) {
      updated.lastTriggered = new Date().toISOString();
      updated.triggerCount = (updated.triggerCount || 0) + 1;
      saveWatches(watchesAfter);
      console.log(`Watch ${watch.id} triggered: ${watch.source} ${watch.target} (${watch.condition})`);
      appendScheduledPlatformEvent("watch", updated, "schedule.watch.triggered", { check_result: checkResult }, { source: "agent", actor: "agent", executionId: checkExecution?.execution_id, rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id });
      const actionResult = await executeWatchAction(watch, checkResult, {
        parentId: checkExecution?.execution_id || watch.platform_execution_id || null,
        rootExecutionId: watch.platform_execution_id || checkExecution?.root_execution_id || null,
        correlationId: watch.id,
      });
      if (checkExecution) platformKernel.transitionExecution(checkExecution.execution_id, actionResult?.isError ? "failed" : "completed", {
        source: "agent",
        actor_id: "agent",
        reason: actionResult?.isError ? "scheduled watch action failed" : "scheduled watch action completed",
        result_status: actionResult?.isError ? "failure" : "success",
        result_summary: actionResult?.content?.[0]?.text || "watch triggered",
        correlation_id: watch.id,
      });
    } else {
      if (checkExecution) platformKernel.transitionExecution(checkExecution.execution_id, "completed", {
        source: "agent",
        actor_id: "agent",
        reason: "scheduled watch check completed without trigger",
        result_status: "not_triggered",
        result_summary: `Watch ${watch.id} did not trigger`,
        correlation_id: watch.id,
      });
      saveWatches(watchesAfter);
    }
  }
}

function scheduleWatch(watch) {
  const intervalMs = parseWatchInterval(watch.interval);
  
  watchIntervals[watch.id] = setInterval(() => {
    checkWatch(watch);
  }, intervalMs);
  
  console.log(`Scheduled watch ${watch.id} every ${watch.interval} (${intervalMs}ms)`);
}

function loadAndScheduleWatches() {
  const watches = loadWatches();
  const active = watches.filter(w => w.status === "active");
  
  for (const watch of active) {
    scheduleWatch(watch);
  }
  
  console.log(`Loaded ${active.length} active watches`);
}

loadAndScheduleWatches();

process.on("uncaughtException", (e) => {
  console.error("Uncaught:", e.message);
});

if (!GROQ_API_KEY) {
  setTimeout(() => {
    const http = require("http");
    const body = JSON.stringify({ model: "phi3:mini", prompt: "hello", stream: false });
    const req = http.request({
      hostname: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    });
    req.write(body); req.end();
    req.on("error", () => {});
    req.setTimeout(300000, () => req.destroy());
  }, 1000);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const taskEmitters = {};

function buildSystemPrompt() {
  const availableTools = getToolDefsForSource("agent").filter(t => t.enabled);
  const toolDescs = availableTools.map(t =>
    "- " + t.name + "(" + Object.keys(t.args).join(", ") + "): " + t.description + " [risk: " + t.risk + "]"
  ).join("\n");
  return "You are an autonomous agent running on a remote machine.\n\n" +
    "CRITICAL RULES:\n" +
    "1. Do NOT repeat or verify a result you already have. Trust tool outputs.\n" +
    "2. Do NOT run the same command twice with minor variations.\n" +
    "3. Do NOT write results to files or re-read data unless explicitly asked.\n" +
    "4. Never ask for confirmation.\n" +
    "5. Continue calling tools until EVERY part of the task is complete.\n" +
    "6. Call done ONLY after all steps are finished.\n" +
    "7. NEVER describe tool calls inside think blocks. Think blocks are for reasoning ONLY.\n" +
    "8. If you think about calling a tool, you MUST actually call it in your next response.\n" +
    "9. NEVER invent tool names. ONLY use tools from the list below. If a tool doesn't exist, do NOT guess its name.\n" +
    "10. For simple responses or when no tool action is needed, use sidekick_respond to return text directly.\n\n" +
    "Response format (choose ONE, output raw JSON only):\n" +
    '- {"think": "your reasoning here"}  -- reasoning only, NO tool descriptions\n' +
    '- {"tool": "tool_name", "arguments": {"key": "value"}}  -- execute a tool\n' +
    '- {"done": true, "result": "final answer"}  -- task fully complete\n\n' +
    "WRONG: {\"think\": \"Called sidekick_get -> result\"}  -- do NOT mimic tool output in think\n" +
    "RIGHT: {\"tool\": \"sidekick_get\", \"arguments\": {\"key\": \"mykey\"}}\n\n" +
    "Example (simple): sidekick_bash returns \"64.176.216.202\" for IP query\n" +
    "-> {\"done\": true, \"result\": \"Your public IP is 64.176.216.202\"}\n\n" +
    "Example (multi-step): \"store disk usage and retrieve it\"\n" +
    "-> {\"tool\": \"sidekick_bash\", \"arguments\": {\"command\": \"df -h\"}}\n" +
    "-> {\"tool\": \"sidekick_store\", \"arguments\": {\"key\": \"disk\", \"value\": \"23%\"}}\n" +
    "-> {\"tool\": \"sidekick_get\", \"arguments\": {\"key\": \"disk\"}}\n" +
    "-> {\"done\": true, \"result\": \"Disk usage: 23%\"}\n\n" +
    "Example (two retrievals): \"store A and B, then retrieve both\"\n" +
    "-> {\"tool\": \"sidekick_store\", \"arguments\": {\"key\": \"A\", \"value\": \"1\"}}\n" +
    "-> {\"tool\": \"sidekick_store\", \"arguments\": {\"key\": \"B\", \"value\": \"2\"}}\n" +
    "-> {\"tool\": \"sidekick_get\", \"arguments\": {\"key\": \"A\"}}\n" +
    "-> {\"tool\": \"sidekick_get\", \"arguments\": {\"key\": \"B\"}}  -- MUST call this, do NOT skip\n" +
    "-> {\"done\": true, \"result\": \"A=1, B=2\"}\n\n" +
    "Example (simple response): \"say hi in one word\"\n" +
    "-> {\"tool\": \"sidekick_respond\", \"arguments\": {\"text\": \"Hi\"}}\n" +
    "-> {\"done\": true, \"result\": \"Hi\"}\n\n" +
    "You have these tools:\n" + toolDescs;
}

async function callLLM(messages, options = {}) {
  if (inferenceService) {
    try {
      const chatMessages = messages.map(m => ({ role: m.role, content: m.content }));
      const result = await inferenceService.chat({
        messages: chatMessages,
        temperature: typeof options.temperature === "number" ? options.temperature : 0.3,
        format: options.format,
        preferences: { allowFallback: true },
      }, { systemPrompt: options.systemPrompt || buildSystemPrompt() });
      return { response: result.content || "", model: result.modelId || "unknown", provider: result.providerId || "unknown" };
    } catch (e) {
      if (GROQ_API_KEY) {
        try {
          const result = await callGroqLLM(messages, options);
          result.provider = "groq";
          result.fallback = true;
          return result;
        } catch (groqErr) {
          throw new Error("Compute failed: " + e.message + " | Groq fallback failed: " + groqErr.message);
        }
      }
      throw e;
    }
  }
  try {
    const result = await callOllamaLLM(messages, options);
    result.provider = "ollama";
    return result;
  } catch (ollamaErr) {
    if (GROQ_API_KEY) {
      try {
        const result = await callGroqLLM(messages, options);
        result.provider = "groq";
        result.fallback = true;
        return result;
      } catch (groqErr) {
        throw new Error("Ollama failed: " + ollamaErr.message + " | Groq fallback failed: " + groqErr.message);
      }
    }
    throw ollamaErr;
  }
}

async function callAgentLLM(messages) {
  return callLLM(messages, { systemPrompt: buildSystemPrompt(), format: "json", temperature: 0.3 });
}

async function callDirectAnswerLLM(goal, combinedBrief) {
  const messages = [];
  if (combinedBrief) {
    messages.push({
      role: "system",
      content: "Relevant remembered Sidekick context. Use it if helpful, but do not assume it is complete:\n" + combinedBrief
    });
  }
  messages.push({ role: "user", content: goal });

  return callLLM(messages, {
    systemPrompt: "You are a helpful assistant. Answer the user's question directly and succinctly in plain text. Do not use tools, JSON, or mention internal routing. If the answer is not known, say so briefly.",
    temperature: 0.2
  });
}

function callGroqLLM(messages, options = {}, attempt = 1) {
  const systemPrompt = options.systemPrompt || buildSystemPrompt();
  const temperature = typeof options.temperature === "number" ? options.temperature : 0.3;
  return new Promise((resolve, reject) => {
    const https = require("https");
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ],
      temperature
    });
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 429 && attempt < 5) {
            const wait = Math.min(10000, 1000 * Math.pow(2, attempt));
            return setTimeout(() => resolve(callGroqLLM(messages, options, attempt + 1)), wait);
          }
          if (res.statusCode >= 400) {
            return reject(new Error("Groq: " + (parsed.error?.message || data.substring(0, 200))));
          }
          const content = parsed.choices?.[0]?.message?.content || "";
          resolve({ response: content, model: GROQ_MODEL });
        } catch (e) {
          reject(new Error("Groq parse: " + data.substring(0, 200)));
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("LLM timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function detectBestModel() {
  return new Promise((resolve) => {
    const configuredModel = process.env.SIDEKICK_AGENT_MODEL || "";
    if (configuredModel) return resolve(configuredModel);
    const http = require("http");
    const req = http.request({
      hostname: "127.0.0.1", port: 11434, path: "/api/tags", method: "GET"
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const models = parsed.models || [];
          resolve(selectBestModelName(models.map(m => m.name)));
        } catch {
          resolve("phi3:mini");
        }
      });
    });
    req.on("error", () => resolve("phi3:mini"));
    req.setTimeout(5000, () => { req.destroy(); resolve("phi3:mini"); });
    req.end();
  });
}

function callOllamaLLM(messages, options = {}) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    detectBestModel().then((model) => {
      const systemPrompt = options.systemPrompt || buildSystemPrompt();
      const temperature = typeof options.temperature === "number" ? options.temperature : 0.3;
      const responseFormat = Object.prototype.hasOwnProperty.call(options, "format") ? options.format : undefined;
      const body = JSON.stringify({
        model: model,
        messages: buildChatMessages(systemPrompt, messages),
        ...(responseFormat ? { format: responseFormat } : {}),
        options: { temperature },
        stream: false
      });
      const req = http.request({
        hostname: "127.0.0.1", port: 11434, path: "/api/chat", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode >= 400 || result.error) {
              return reject(new Error("Ollama: " + (result.error || data.substring(0, 200))));
            }
            result.model = model;
            result.response = result.message?.content || "";
            resolve(result);
          }
          catch { reject(new Error("LLM parse fail: " + data.substring(0, 200))); }
        });
      });
      req.setTimeout(300000, () => { req.destroy(); reject(new Error("LLM timeout")); });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  });
}

function emit(taskId, data) {
  const ee = taskEmitters[taskId];
  if (ee) ee.emit("data", data);
}

function startAgentExecution(goal, taskId, project) {
  try {
    const execution = platformKernel.createExecution({
      task_id: taskId,
      project_id: project || null,
      actor_id: "agent",
      client_id: "agent-bridge",
      trigger_type: "agent",
      operation_type: "agent_task",
      tool_name: "sidekick_agent",
      tool_action: "run",
      resource_scope: project || "agent",
      environment: process.env.SIDEKICK_ENVIRONMENT || null,
      risk: "medium",
      source: "agent",
      correlation_id: taskId,
      metadata: { goal_summary: redactSensitive(String(goal || "")).slice(0, 300) },
    });
    return platformKernel.transitionExecution(execution.execution_id, "running", { source: "agent", reason: "agent task started" });
  } catch {
    return null;
  }
}

function appendAgentExecutionEvent(execution, eventType, payload = {}, severity = "info") {
  if (!execution) return;
  try {
    platformKernel.appendEvent({
      event_type: eventType,
      source: "agent",
      actor_id: execution.actor_id,
      execution_id: execution.execution_id,
      root_execution_id: execution.root_execution_id,
      task_id: execution.task_id,
      session_id: execution.session_id,
      project_id: execution.project_id,
      environment: execution.environment,
      severity,
      payload,
      correlation_id: execution.root_execution_id,
    });
  } catch {
    // Platform observability must not interrupt agent task execution.
  }
}

function finishAgentExecution(execution, status, details = {}) {
  if (!execution) return;
  const state = status === "completed" ? "completed" : status === "iteration_limit" ? "timed_out" : "failed";
  try {
    platformKernel.transitionExecution(execution.execution_id, state, {
      source: "agent",
      actor_id: execution.actor_id,
      result_status: status,
      error_category: details.error_category || null,
      result_summary: details.result_summary || null,
      reason: details.reason || null,
    });
  } catch {
    // Platform observability must not interrupt agent task execution.
  }
}

function registerAgentTranscript(execution, transcriptPath, taskId, status) {
  if (!execution || !transcriptPath) return;
  try {
    const stat = fs.statSync(transcriptPath);
    platformKernel.registerArtifact({
      execution_id: execution.execution_id,
      task_id: execution.task_id,
      project_id: execution.project_id,
      producer: "agent",
      type: "agent_transcript",
      name: `${taskId}.json`,
      storage_ref: path.relative(DATA_DIR, transcriptPath),
      content_type: "application/json",
      byte_size: stat.size,
      sensitivity: "sensitive",
      redaction_state: "unknown",
      source: "agent",
      correlation_id: execution.root_execution_id,
      metadata: { status },
    });
  } catch {
    // Transcript remains available through the existing conversation store.
  }
}

function suggestGroqLLM(prompt, attempt = 1) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: "You analyze agent task transcripts and decide if they should be saved as reusable procedures. Return only valid JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    });
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 429 && attempt < 3) {
            const wait = Math.min(5000, 1000 * Math.pow(2, attempt));
            return setTimeout(() => resolve(suggestGroqLLM(prompt, attempt + 1)), wait);
          }
          if (res.statusCode >= 400) {
            return reject(new Error("Groq: " + (parsed.error?.message || data.substring(0, 200))));
          }
          const content = parsed.choices?.[0]?.message?.content || "";
          resolve(content);
        } catch (e) {
          reject(new Error("Groq parse: " + data.substring(0, 200)));
        }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("LLM timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function suggestProcedure(goal, steps, taskId) {
  const toolSteps = steps.filter(s => s.type === "tool");
  if (toolSteps.length < 3) return;

  const transcript = toolSteps.map(s => {
    const argsStr = JSON.stringify(s.args || {});
    return `- ${s.tool}(${argsStr})`;
  }).join("\n");

  const prompt = `Analyze this agent task and decide if it should be saved as a reusable procedure.

Task goal: "${goal}"

Steps taken:
${transcript}

Return a JSON object:
- If this should be saved: {"save": true, "name": "snake_case_name", "description": "what it does", "parameters": {"paramName": {"type": "string", "description": "...", "required": true}}, "steps": [{"tool": "sidekick_bash", "args": {"command": "..."}}]}
- If not: {"save": false, "reason": "why not"}

Rules for saving:
- Save if the task is a reusable pattern (e.g., "check disk space", "backup database", "deploy service")
- Don't save if it's a one-off query (e.g., "what time is it", "get my IP")
- Use {{paramName}} in step args for values that should be parameterized
- Only include parameters for values that would change between uses
- Keep steps minimal — remove verification/redundant steps

Return ONLY valid JSON.`;

  try {
    const response = await suggestGroqLLM(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    
    const suggestion = JSON.parse(jsonMatch[0]);
    if (!suggestion.save) {
      emit(taskId, { type: "step", text: `Procedure suggestion: skipped (${suggestion.reason || "not reusable"})` });
      return;
    }

    if (!suggestion.name || !suggestion.description || !Array.isArray(suggestion.steps)) {
      emit(taskId, { type: "step", text: "Procedure suggestion: invalid format" });
      return;
    }

    const result = await callTool("sidekick_teach", {
      action: "teach_procedure",
      name: suggestion.name,
      description: suggestion.description,
      parameters: suggestion.parameters || {},
      steps: suggestion.steps,
      trigger_phrases: []
    });

    if (result.isError) {
      emit(taskId, { type: "step", text: `Procedure save failed: ${result.content?.[0]?.text}` });
    } else {
      const paramCount = Object.keys(suggestion.parameters || {}).length;
      emit(taskId, { type: "step", text: `Auto-saved procedure: ${suggestion.name} (${suggestion.steps.length} steps, ${paramCount} params) — available as sidekick_${suggestion.name} after restart` });
    }
  } catch (e) {
    emit(taskId, { type: "step", text: `Procedure suggestion failed: ${e.message}` });
  }
}

async function runAgent(goal, taskId) {
  setSource("agent");
  const steps = [];
  const inferredProject = inferProjectFromText(goal);
  const platformExecution = startAgentExecution(goal, taskId, inferredProject);
  const memoryBrief = inferredProject ? buildMemoryBrief(goal, { project: inferredProject }) : null;

  let semanticRecall = [];
  if (inferredProject) {
    try {
      semanticRecall = await recallMemoryForTextAsync(goal, { project: inferredProject, limit: 5 });
    } catch {}
  }

  const briefParts = [];
  if (memoryBrief) briefParts.push(memoryBrief);
  if (semanticRecall.length > 0) {
    const semanticText = formatMemoryRecall(semanticRecall.filter(r => r.semantic));
    if (semanticText) briefParts.push("# Semantic Recall\n\n" + semanticText);
  }

  const combinedBrief = briefParts.length > 0 ? briefParts.join("\n\n") : null;
  const useTools = requiresToolUse(goal);

  let status = "iteration_limit";
  let finalResult = "";
  let terminalError = "";
  let repeatState = { fingerprint: "", repeats: 0 };

  emit(taskId, { type: "step", text: "Analyzing task: " + goal });
  appendAgentExecutionEvent(platformExecution, "agent.task_started", { task_id: taskId, project: inferredProject, use_tools: useTools });
  if (combinedBrief) {
    emit(taskId, { type: "step", text: "Loaded memory brief with relevant context" });
    appendAgentExecutionEvent(platformExecution, "agent.memory_brief_loaded", { task_id: taskId, project: inferredProject });
  }

  if (!useTools) {
    try {
      const response = await callDirectAnswerLLM(goal, combinedBrief);
      emit(taskId, { type: "provider", name: response.provider, model: response.model || "unknown" });
      if (response.fallback) {
        emit(taskId, { type: "fallback", from: "ollama", to: "groq" });
      }
      finalResult = (response.response || "").trim() || "I couldn't generate an answer.";
      steps.push({ type: "done", text: finalResult });
      status = "completed";
    } catch (e) {
      steps.push({ type: "error", text: e.message });
      status = "failed";
      terminalError = "LLM error: " + e.message;
    }
  } else {
    const history = combinedBrief
      ? [
          { role: "system", content: "Relevant remembered Sidekick context. Use it when helpful, but do not assume it is complete:\n" + combinedBrief },
          { role: "user", content: goal }
        ]
      : [{ role: "user", content: goal }];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let response;
      try {
        response = await callAgentLLM(history);
        if (i === 0) {
          emit(taskId, { type: "provider", name: response.provider, model: response.model || "unknown" });
        }
        if (response.fallback) {
          emit(taskId, { type: "fallback", from: "ollama", to: "groq" });
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
        emit(taskId, { type: "step", text: decision.think });
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
        // Tool validation: check if tool exists before calling
        const availableToolDefs = getToolDefsForSource("agent").filter(t => t.enabled);
        const validTool = availableToolDefs.find(t => t.name === decision.tool);
        if (!validTool) {
          emit(taskId, { type: "step", text: "Unknown tool: " + decision.tool });
          steps.push({ type: "tool", tool: decision.tool, args: decision.arguments, result: "Error: tool does not exist" });
          const availableTools = availableToolDefs.map(t => t.name).join(", ");
          history.push({ role: "assistant", content: "Called " + decision.tool + " → Error: tool does not exist" });
          history.push({ role: "user", content: "Tool '" + decision.tool + "' does not exist. Available tools: " + availableTools + ". Use sidekick_respond to return text directly, or choose a valid tool from the list." });
          continue;
        }

        // Deduplication check: prevent repeated identical tool calls
        const toolKey = decision.tool + ":" + JSON.stringify(decision.arguments || {});
        const recentCalls = steps.slice(-3).filter(s => s.type === "tool" && s.tool === decision.tool && JSON.stringify(s.args) === JSON.stringify(decision.arguments || {}));
        if (recentCalls.length >= 1) {
          emit(taskId, { type: "step", text: "Blocked: repeated call to " + decision.tool + " with same arguments" });
          history.push({ role: "assistant", content: "Called " + decision.tool + " → (blocked: already called)" });
          // Collect all retrieved values from previous get calls
          const retrievedValues = steps.filter(s => s.type === "tool" && s.tool === "sidekick_get").map(s => s.args.key + "=" + (s.result || "").substring(0, 50)).join(", ");
          history.push({ role: "user", content: "You already have all the data. Call done NOW with this result: " + retrievedValues + ". Do NOT call any more tools." });
          continue;
        }

        emit(taskId, { type: "tool", tool: decision.tool, summary: JSON.stringify(decision.arguments) });
        appendAgentExecutionEvent(platformExecution, "agent.tool_started", { task_id: taskId, tool: decision.tool, argument_keys: Object.keys(decision.arguments || {}) });
        steps.push({ type: "tool", tool: decision.tool, args: decision.arguments });

        let result;
        try {
          const toolRes = await callTool(decision.tool, decision.arguments || {});
          if (toolRes.isError) {
            result = "Error: " + (toolRes.content?.[0]?.text || "unknown error");
            // If policy or lookup blocks a tool, provide corrective feedback.
            if (result.includes("Unknown tool") || result.includes("Tool blocked by policy")) {
              const availableTools = getToolDefsForSource("agent").filter(t => t.enabled).map(t => t.name).join(", ");
              result += ". Available tools: " + availableTools + ". Use sidekick_respond to return text directly.";
            }
          } else {
            result = toolRes.content?.[0]?.text || "(empty result)";
          }
        } catch (e) {
          result = "Call failed: " + e.message;
        }

        const summary = result.substring(0, 500);
        emit(taskId, { type: "tool", tool: decision.tool, summary: summary.substring(0, 120) });
        appendAgentExecutionEvent(platformExecution, "agent.tool_completed", { task_id: taskId, tool: decision.tool, ok: !result.startsWith("Error:") && !result.startsWith("Call failed:"), summary: redactSensitive(summary).substring(0, 200) }, result.startsWith("Error:") || result.startsWith("Call failed:") ? "error" : "info");
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
  }

  if (status === "iteration_limit") {
    terminalError = `Agent stopped after ${MAX_ITERATIONS} iterations without a final answer`;
    steps.push({ type: "error", text: terminalError });
  }

  const transcript = JSON.stringify({ goal, steps, status, t: new Date().toISOString() });
  const transcriptPath = path.join(CONV_DIR, taskId + ".json");
  fs.writeFileSync(transcriptPath, transcript, "utf-8");
  registerAgentTranscript(platformExecution, transcriptPath, taskId, status);

  if (status === "completed") {
    try {
      const saved = recordAgentTaskMemory({ goal, steps, taskId, status });
      if (saved) emit(taskId, { type: "step", text: "Saved automatic memory for this task" });
      if (saved?.extracted?.length) {
        emit(taskId, { type: "step", text: `Extracted ${saved.extracted.length} structured memory item(s)` });
      }
    } catch (e) {
      emit(taskId, { type: "step", text: "Automatic memory save failed: " + e.message });
    }

    await suggestProcedure(goal, steps, taskId);
  }

  if (status === "completed") {
    emit(taskId, { type: "done", text: finalResult });
  } else {
    emit(taskId, { type: "error", text: terminalError });
  }
  finishAgentExecution(platformExecution, status, { result_summary: status === "completed" ? finalResult : terminalError, reason: terminalError || "agent task completed", error_category: status === "completed" ? null : status });
}

app.post("/api/agent/run", (req, res) => {
  const { goal } = req.body;
  if (!goal) return res.status(400).json({ error: "goal required" });
  const taskId = crypto.randomUUID().slice(0, 8);
  taskEmitters[taskId] = new EventEmitter();
  res.json({ taskId });
  runAgent(goal, taskId).finally(() => {
    setTimeout(() => delete taskEmitters[taskId], 60000);
  });
});

app.get("/api/agent/stream/:taskId", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.write(":\n\n");

  const ee = taskEmitters[req.params.taskId];
  if (!ee) {
    res.write("data: " + JSON.stringify({ type: "done", text: "Task not found" }) + "\n\n");
    res.end();
    return;
  }

  const handler = (data) => {
    res.write("data: " + JSON.stringify(data) + "\n\n");
    if (data.type === "done" || data.type === "error") {
      ee.off("data", handler);
      res.end();
    }
  };
  ee.on("data", handler);
  req.on("close", () => ee.off("data", handler));
});

app.get("/api/agent/history", (req, res) => {
  const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith(".json")).sort().reverse().slice(0, 20);
  const runs = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), "utf-8"));
      return { id: f.replace(".json", ""), goal: data.goal, status: data.status, t: data.t };
    } catch { return null; }
  }).filter(Boolean);
  res.json({ runs });
});

app.get("/api/agent/run/:id", (req, res) => {
  const file = path.join(CONV_DIR, req.params.id + ".json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  try { res.json(JSON.parse(fs.readFileSync(file, "utf-8"))); }
  catch { res.status(500).json({ error: "parse error" }); }
});

app.get("/api/agent/status", (req, res) => {
  const activeTasks = Object.keys(taskEmitters).length;
  res.json({ activeTasks });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/delays/reload", (req, res) => {
  loadAndScheduleDelays();
  res.json({ ok: true });
});

app.post("/api/watches/reload", (req, res) => {
  for (const id in watchIntervals) {
    clearInterval(watchIntervals[id]);
  }
  loadAndScheduleWatches();
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("Sidekick agent bridge listening on http://127.0.0.1:" + PORT);
});
