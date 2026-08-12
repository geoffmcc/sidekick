"use strict";

// Flow-control tool family: queue, retry, orchestrate, batch, circuit.
//
// Extracted from src/tools-legacy.js. Every handler that runs other tools does
// so through the nested dispatch seam (callTool) — no family imports
// tools-legacy.js. isBuiltinToolName moves here with its only consumer (batch)
// and resolves TOOL_DEFS lazily from the tool facade at call time (cycle-safe).
// The queue/orchestrate/circuit JSON stores live under DATA_DIR (re-based for
// families/). Risks preserved from src/tools/metadata.js.

const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { callTool } = require("../dispatch-seam");
const { stripSidekickPrefix } = require("../../core/tool-name");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Canonical-name check for batch, moved verbatim from tools-legacy with its
// memo. TOOL_DEFS is read lazily from the registry-derived facade to avoid a
// module-init dependency on tools-legacy; names are immutable per process.
// Set membership (not object lookup) so inherited names like "constructor"
// cannot pass the check.
let builtinToolNames = null;
function isBuiltinToolName(name) {
  if (!builtinToolNames) {
    const { TOOL_DEFS } = require("../index");
    builtinToolNames = new Set(TOOL_DEFS.map(def => stripSidekickPrefix(def.name)));
  }
  return builtinToolNames.has(stripSidekickPrefix(name));
}

const QUEUE_FILE = path.join(DATA_DIR, "queue.json");

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return { tasks: [], nextId: 1 };
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

async function sidekick_queue({ action, id, tool, args, priority, status }) {
  const queue = loadQueue();

  if (action === "add") {
    if (!tool) {
      return { content: [{ type: "text", text: "tool required" }], isError: true };
    }

    const task = {
      id: queue.nextId++,
      tool,
      args: args || {},
      priority: priority || 0,
      status: "pending",
      created: new Date().toISOString(),
      attempts: 0
    };

    queue.tasks.push(task);
    queue.tasks.sort((a, b) => b.priority - a.priority);
    saveQueue(queue);

    return { content: [{ type: "text", text: `Added task ${task.id} (priority: ${task.priority})` }] };
  }

  if (action === "list") {
    const filterStatus = status || "all";
    const filtered = filterStatus === "all"
      ? queue.tasks
      : queue.tasks.filter(t => t.status === filterStatus);

    if (filtered.length === 0) {
      return { content: [{ type: "text", text: `No tasks found (status: ${filterStatus})` }] };
    }

    const summary = filtered.map(t =>
      `Task ${t.id}: ${t.tool} (priority: ${t.priority}, status: ${t.status}, attempts: ${t.attempts})`
    ).join("\n");

    return { content: [{ type: "text", text: `Queue (${filtered.length} tasks):\n${summary}` }] };
  }

  if (action === "process") {
    const pending = queue.tasks.find(t => t.status === "pending");

    if (!pending) {
      return { content: [{ type: "text", text: "No pending tasks" }] };
    }

    pending.status = "processing";
    pending.attempts++;
    saveQueue(queue);

    try {
      const result = await callTool(pending.tool, pending.args);

      if (result.isError) {
        pending.status = "failed";
        pending.error = result.content?.[0]?.text || "Unknown error";
        pending.failedAt = new Date().toISOString();
      } else {
        pending.status = "completed";
        pending.result = result.content?.[0]?.text?.substring(0, 200);
        pending.completedAt = new Date().toISOString();
      }

      saveQueue(queue);
      return result;
    } catch (e) {
      pending.status = "failed";
      pending.error = e.message;
      pending.failedAt = new Date().toISOString();
      saveQueue(queue);

      return { content: [{ type: "text", text: `Task failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "remove") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const idx = queue.tasks.findIndex(t => t.id === id);
    if (idx === -1) {
      return { content: [{ type: "text", text: `Task ${id} not found` }], isError: true };
    }

    queue.tasks.splice(idx, 1);
    saveQueue(queue);

    return { content: [{ type: "text", text: `Removed task ${id}` }] };
  }

  if (action === "clear") {
    const clearStatus = status || "all";

    if (clearStatus === "all") {
      queue.tasks = [];
    } else {
      queue.tasks = queue.tasks.filter(t => t.status !== clearStatus);
    }

    saveQueue(queue);
    return { content: [{ type: "text", text: `Cleared tasks (status: ${clearStatus})` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: add, list, process, remove, clear" }], isError: true };
}


async function sidekick_retry({ tool, args, max_attempts, backoff, initial_delay }) {
  if (!tool) {
    return { content: [{ type: "text", text: "tool required" }], isError: true };
  }

  const maxAttempts = max_attempts || 3;
  const backoffType = backoff || "exponential";
  const initialDelay = initial_delay || 1000;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callTool(tool, args || {});

      if (!result.isError) {
        return { content: [{ type: "text", text: `✓ Succeeded on attempt ${attempt}\n\n${result.content?.[0]?.text || ""}` }] };
      }

      lastError = result.content?.[0]?.text || "Unknown error";
    } catch (e) {
      lastError = e.message;
    }

    if (attempt < maxAttempts) {
      let delay;
      if (backoffType === "exponential") {
        delay = initialDelay * Math.pow(2, attempt - 1);
      } else if (backoffType === "linear") {
        delay = initialDelay * attempt;
      } else {
        delay = initialDelay;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { content: [{ type: "text", text: `✗ Failed after ${maxAttempts} attempts\nLast error: ${lastError}` }], isError: true };
}


const ORCHESTRATE_FILE = path.join(DATA_DIR, "orchestrate.json");

function loadOrchestrate() {
  if (!fs.existsSync(ORCHESTRATE_FILE)) return { tasks: [], nextId: 1 };
  try {
    return JSON.parse(fs.readFileSync(ORCHESTRATE_FILE, "utf-8"));
  } catch {
    return { tasks: [], nextId: 1 };
  }
}

function saveOrchestrate(orchestrate) {
  fs.writeFileSync(ORCHESTRATE_FILE, JSON.stringify(orchestrate, null, 2));
}

async function sidekick_orchestrate({ action, id, task_name, subtasks, dependencies, timeout }) {
  const orchestrate = loadOrchestrate();
  const now = new Date().toISOString();

  if (action === "create") {
    if (!task_name || !subtasks || !Array.isArray(subtasks)) {
      return { content: [{ type: "text", text: "task_name and subtasks array required" }], isError: true };
    }

    const taskId = orchestrate.nextId++;
    const task = {
      id: taskId,
      name: task_name,
      subtasks: subtasks.map((st, idx) => ({
        id: `${taskId}-${idx}`,
        name: st.name || `Subtask ${idx + 1}`,
        tool: st.tool,
        args: st.args || {},
        status: "pending",
        result: null,
        error: null
      })),
      dependencies: dependencies || {},
      status: "created",
      created: now,
      timeout: timeout || 1800000, // 30 minutes default
      results: {}
    };

    orchestrate.tasks.push(task);
    saveOrchestrate(orchestrate);

    return { content: [{ type: "text", text: `Task ${taskId} created with ${subtasks.length} subtasks\nName: ${task_name}` }] };
  }

  if (action === "execute") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }

    task.status = "executing";
    task.startedAt = now;
    saveOrchestrate(orchestrate);

    // Execute subtasks respecting dependencies
    const executed = new Set();
    const results = {};

    for (const subtask of task.subtasks) {
      const deps = task.dependencies[subtask.id] || [];
      const depsMet = deps.every(d => executed.has(d));

      if (!depsMet) {
        subtask.status = "skipped";
        subtask.error = "Dependencies not met";
        continue;
      }

      subtask.status = "running";
      saveOrchestrate(orchestrate);

      try {
        const result = await callTool(subtask.tool, subtask.args);
        subtask.status = result.isError ? "failed" : "completed";
        subtask.result = result.content?.[0]?.text?.substring(0, 500);
        subtask.error = result.isError ? result.content?.[0]?.text : null;
        results[subtask.id] = subtask.result;
        executed.add(subtask.id);
      } catch (e) {
        subtask.status = "failed";
        subtask.error = e.message;
      }

      saveOrchestrate(orchestrate);
    }

    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.results = results;
    saveOrchestrate(orchestrate);

    const summary = task.subtasks.map(st =>
      `${st.name}: ${st.status}${st.error ? ` (${st.error.substring(0, 50)})` : ""}`
    ).join("\n");

    return { content: [{ type: "text", text: `Task ${id} executed\n\nSubtask Results:\n${summary}` }] };
  }

  if (action === "list") {
    if (orchestrate.tasks.length === 0) {
      return { content: [{ type: "text", text: "No orchestration tasks" }] };
    }

    const list = orchestrate.tasks.map(t =>
      `ID: ${t.id}\nName: ${t.name}\nStatus: ${t.status}\nSubtasks: ${t.subtasks.length}\nCreated: ${t.created}`
    ).join("\n\n");

    return { content: [{ type: "text", text: `# Orchestration Tasks (${orchestrate.tasks.length})\n\n${list}` }] };
  }

  if (action === "status") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }

    const status = task.subtasks.map(st =>
      `${st.name}: ${st.status}${st.result ? `\n  Result: ${st.result.substring(0, 100)}...` : ""}${st.error ? `\n  Error: ${st.error.substring(0, 100)}` : ""}`
    ).join("\n\n");

    return { content: [{ type: "text", text: `# Task ${id} Status\n\nName: ${task.name}\nOverall: ${task.status}\n\n## Subtasks\n\n${status}` }] };
  }

  if (action === "cancel") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }

    const task = orchestrate.tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: "text", text: `Task not found: ${id}` }], isError: true };
    }

    task.status = "cancelled";
    task.cancelledAt = new Date().toISOString();
    saveOrchestrate(orchestrate);

    return { content: [{ type: "text", text: `Task ${id} cancelled` }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: create, execute, list, status, cancel" }], isError: true };
}


async function sidekick_batch({ calls }) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return { content: [{ type: "text", text: "calls must be a non-empty array" }], isError: true };
  }
  if (calls.length > 20) {
    return { content: [{ type: "text", text: "Maximum 20 calls per batch" }], isError: true };
  }
  const results = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    // Resolve against TOOL_DEFS rather than the TOOLS handler map: descriptor-owned
    // families (src/tools/families/) keep their TOOL_DEFS row as an ordering anchor
    // but no longer have a legacy handler entry. Every TOOL_DEFS name is dispatchable,
    // so this stays equivalent to the old check for legacy-owned tools while keeping
    // extracted tools reachable. Active module tools are dispatchable too;
    // generated tools stay excluded as before. Execution still goes through
    // callTool -> dispatcher.
    if (!call.tool || !(isBuiltinToolName(call.tool) || require("../../modules/loader").resolveActiveDescriptor(call.tool))) {
      results.push({ index: i, tool: call.tool, error: "Unknown tool: " + call.tool });
      continue;
    }
    const start = Date.now();
    try {
      const result = await callTool(call.tool, call.args || {});
      results.push({
        index: i,
        tool: call.tool,
        result: result.content?.[0]?.text?.substring(0, 500) || "(ok)",
        error: result.isError || false,
        duration_ms: Date.now() - start
      });
    } catch (e) {
      results.push({ index: i, tool: call.tool, error: e.message });
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

const CIRCUIT_FILE = path.join(DATA_DIR, "circuits.json");
const MAX_CIRCUIT_TARGETS = 20;
const CIRCUIT_IDLE_RESET_HOURS = 1;

function loadCircuits() {
  try {
    if (fs.existsSync(CIRCUIT_FILE)) {
      return JSON.parse(fs.readFileSync(CIRCUIT_FILE, "utf8"));
    }
  } catch {}
  return { circuits: {} };
}

function saveCircuits(data) {
  fs.writeFileSync(CIRCUIT_FILE, JSON.stringify(data, null, 2));
}

function cleanupIdleCircuits(data) {
  const now = Date.now();
  const idleMs = CIRCUIT_IDLE_RESET_HOURS * 3600000;
  let cleaned = 0;
  for (const [target, circuit] of Object.entries(data.circuits)) {
    if (now - circuit.lastAccess > idleMs) {
      delete data.circuits[target];
      cleaned++;
    }
  }
  return cleaned;
}

async function sidekick_circuit({ action, target, tool, args, failure_threshold, cooldown_seconds, cache_response }) {
  const data = loadCircuits();
  cleanupIdleCircuits(data);

  if (action === "status") {
    const entries = Object.entries(data.circuits);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No circuits configured" }] };
    }
    const list = entries.map(([t, c]) => {
      const age = Math.round((Date.now() - c.lastAccess) / 1000);
      return `${t}: ${c.state} (failures: ${c.failures}/${c.threshold}, cooldown: ${c.cooldown}s, last: ${age}s ago)`;
    }).join("\n");
    return { content: [{ type: "text", text: `Circuits (${entries.length}/${MAX_CIRCUIT_TARGETS}):\n\n${list}` }] };
  }

  if (action === "reset") {
    if (!target) {
      return { content: [{ type: "text", text: "target required" }], isError: true };
    }
    if (data.circuits[target]) {
      data.circuits[target].state = "closed";
      data.circuits[target].failures = 0;
      data.circuits[target].lastFailure = null;
      saveCircuits(data);
      return { content: [{ type: "text", text: `Circuit reset: ${target}` }] };
    }
    return { content: [{ type: "text", text: `Circuit not found: ${target}` }], isError: true };
  }

  if (action === "configure") {
    if (!target) {
      return { content: [{ type: "text", text: "target required" }], isError: true };
    }
    if (!data.circuits[target]) {
      if (Object.keys(data.circuits).length >= MAX_CIRCUIT_TARGETS) {
        return { content: [{ type: "text", text: `Max circuits reached (${MAX_CIRCUIT_TARGETS})` }], isError: true };
      }
      data.circuits[target] = {
        state: "closed",
        failures: 0,
        threshold: failure_threshold || 5,
        cooldown: cooldown_seconds || 60,
        lastFailure: null,
        lastAccess: Date.now(),
        cachedResponse: null
      };
    } else {
      if (failure_threshold !== undefined) data.circuits[target].threshold = failure_threshold;
      if (cooldown_seconds !== undefined) data.circuits[target].cooldown = cooldown_seconds;
    }
    saveCircuits(data);
    return { content: [{ type: "text", text: `Circuit configured: ${target} (threshold: ${data.circuits[target].threshold}, cooldown: ${data.circuits[target].cooldown}s)` }] };
  }

  if (action === "call") {
    if (!target || !tool) {
      return { content: [{ type: "text", text: "target and tool required" }], isError: true };
    }

    if (!data.circuits[target]) {
      if (Object.keys(data.circuits).length >= MAX_CIRCUIT_TARGETS) {
        return { content: [{ type: "text", text: `Max circuits reached (${MAX_CIRCUIT_TARGETS}). Configure a circuit first.` }], isError: true };
      }
      data.circuits[target] = {
        state: "closed",
        failures: 0,
        threshold: failure_threshold || 5,
        cooldown: cooldown_seconds || 60,
        lastFailure: null,
        lastAccess: Date.now(),
        cachedResponse: null
      };
    }

    const circuit = data.circuits[target];
    circuit.lastAccess = Date.now();
    const now = Date.now();

    if (circuit.state === "open") {
      const elapsed = (now - circuit.lastFailure) / 1000;
      if (elapsed >= circuit.cooldown) {
        circuit.state = "half-open";
      } else {
        const remaining = Math.ceil(circuit.cooldown - elapsed);
        if (cache_response && circuit.cachedResponse) {
          saveCircuits(data);
          return { content: [{ type: "text", text: `[CIRCUIT OPEN - CACHED] ${target}\nCooldown: ${remaining}s remaining\n\n${circuit.cachedResponse}` }] };
        }
        saveCircuits(data);
        return { content: [{ type: "text", text: `[CIRCUIT OPEN] ${target}\nFailures: ${circuit.failures}/${circuit.threshold}\nCooldown: ${remaining}s remaining\nTool: ${tool} (not called)` }], isError: true };
      }
    }

    const result = await callTool(tool, args || {});
    const success = !result.isError;

    if (success) {
      circuit.state = "closed";
      circuit.failures = 0;
      circuit.lastFailure = null;
      if (cache_response && result.content && result.content[0]) {
        circuit.cachedResponse = result.content[0].text;
      }
      saveCircuits(data);
      return result;
    } else {
      circuit.failures++;
      circuit.lastFailure = now;
      if (circuit.failures >= circuit.threshold) {
        circuit.state = "open";
      }
      saveCircuits(data);
      const stateInfo = circuit.state === "open" ? " (CIRCUIT NOW OPEN)" : "";
      return { content: [{ type: "text", text: `${result.content?.[0]?.text || "Tool call failed"}\n\n[CIRCUIT] ${target}: ${circuit.failures}/${circuit.threshold} failures${stateInfo}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: call, status, reset, configure" }], isError: true };
}


const SCHEMAS = {
  queue: z.object({
    action: z.enum(["add", "list", "process", "remove", "clear"]).describe("Queue action"),
    id: z.number().optional().describe("Task ID (for remove action)"),
    tool: z.string().optional().describe("Tool name to queue (for add action)"),
    args: z.record(z.any()).optional().describe("Tool arguments (for add action)"),
    priority: z.number().optional().describe("Task priority, higher = more important (default: 0)"),
    status: z.string().optional().describe("Status filter for list/clear: pending, processing, completed, failed, or all")
  }),
  retry: z.object({
    tool: z.string().describe("Tool name to retry"),
    args: z.record(z.any()).optional().describe("Tool arguments"),
    max_attempts: z.number().optional().describe("Maximum retry attempts (default: 3)"),
    backoff: z.enum(["exponential", "linear", "fixed"]).optional().describe("Backoff strategy (default: exponential)"),
    initial_delay: z.number().optional().describe("Initial delay in milliseconds (default: 1000)")
  }),
  orchestrate: z.object({
    action: z.enum(["create", "execute", "list", "status", "cancel"]).describe("Orchestrate action"),
    id: z.number().optional().describe("Task ID (for execute/status/cancel)"),
    task_name: z.string().optional().describe("Task name (for create)"),
    subtasks: z.array(z.record(z.any())).optional().describe("Subtask definitions (for create)"),
    dependencies: z.record(z.array(z.string())).optional().describe("Dependency map (for create)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 1800000)")
  }),
  batch: z.object({
    calls: z.array(z.object({
      tool: z.string().describe("Tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments for the tool")
    })).describe("Array of tool calls to execute (max 20)")
  }),
  circuit: z.object({
    action: z.enum(["call", "status", "reset", "configure"]),
    target: z.string().describe("Circuit target label (e.g., 'github-api', 'web-fetch')"),
    tool: z.string().optional().describe("Tool name to call (for action=call)"),
    args: z.record(z.any()).optional().describe("Tool arguments (for action=call)"),
    failure_threshold: z.number().optional().default(5),
    cooldown_seconds: z.number().optional().default(60),
    cache_response: z.boolean().optional().default(false)
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "queue",
    description: "Persistent task queue with priorities",
    schema: SCHEMAS.queue,
    args: { action: "string (add|list|process|remove|clear)", id: "number (optional, task id for remove)", tool: "string (optional, tool name for add)", args: "object (optional, tool args for add)", priority: "number (optional, priority for add, default 0)", status: "string (optional, status filter for list/clear)" },
    risk: "high",
    category: "Workflow",
    source: "builtin",
    family: "flow-control",
    handler: sidekick_queue,
  }),
  Object.freeze({
    name: "retry",
    description: "Retry tool calls with exponential backoff",
    schema: SCHEMAS.retry,
    args: { tool: "string (tool to retry)", args: "object (optional, tool args)", max_attempts: "number (optional, default 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" },
    risk: "medium",
    category: "Workflow",
    source: "builtin",
    family: "flow-control",
    handler: sidekick_retry,
  }),
  Object.freeze({
    name: "orchestrate",
    description: "Multi-agent coordination: create task graphs, execute subtasks with dependencies, track progress",
    schema: SCHEMAS.orchestrate,
    args: { action: "string (create|execute|list|status|cancel)", id: "number (optional, task id for execute/status/cancel)", task_name: "string (optional, task name for create)", subtasks: "array (optional, subtask definitions for create)", dependencies: "object (optional, dependency map for create)", timeout: "number (optional, timeout in ms, default 1800000)" },
    risk: "high",
    category: "Workflow",
    source: "builtin",
    family: "flow-control",
    handler: sidekick_orchestrate,
  }),
  Object.freeze({
    name: "batch",
    description: "Execute multiple tool calls in one request to reduce API round-trips. Max 20 calls per batch.",
    schema: SCHEMAS.batch,
    args: { calls: "array (array of { tool: string, args: object })" },
    risk: "medium",
    category: "Efficiency",
    source: "builtin",
    family: "flow-control",
    handler: sidekick_batch,
  }),
  Object.freeze({
    name: "circuit",
    description: "Circuit breaker for tool calls. Prevents cascading failures by fast-failing when a target is down.",
    schema: SCHEMAS.circuit,
    args: { action: "string (call|status|reset|configure)", target: "string (circuit target label)", tool: "string (optional, tool name for call action)", args: "object (optional, tool arguments for call action)", failure_threshold: "number (optional, failures before opening - default 5)", cooldown_seconds: "number (optional, seconds before half-open - default 60)", cache_response: "boolean (optional, cache last successful response - default false)" },
    risk: "medium",
    category: "Reliability",
    source: "builtin",
    family: "flow-control",
    handler: sidekick_circuit,
  }),
]);

module.exports = { descriptors, sidekick_queue, sidekick_retry, sidekick_orchestrate, sidekick_batch, sidekick_circuit };
