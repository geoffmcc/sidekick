const EXECUTORS = new Map();
const EXECUTOR_SCHEMAS = new Map();

function registerExecutor(definition) {
  if (!definition.type || !definition.version || !definition.execute) {
    throw new Error("Executor must have type, version, and execute function");
  }
  const key = definition.type + "@" + definition.version;
  if (EXECUTORS.has(key)) {
    throw new Error("Executor already registered: " + key);
  }
  EXECUTORS.set(key, {
    type: definition.type,
    version: definition.version,
    description: definition.description || "",
    risk: definition.risk || "medium",
    capabilities: definition.capabilities || [],
    platforms: definition.platforms || ["linux", "darwin", "win32"],
    inputSchema: definition.inputSchema || {},
    outputSchema: definition.outputSchema || {},
    resourceLimits: definition.resourceLimits || {},
    timeout: definition.timeout || 300000,
    cancellation: definition.cancellation !== false,
    maxInputSize: definition.maxInputSize || 10 * 1024 * 1024,
    maxOutputSize: definition.maxOutputSize || 50 * 1024 * 1024,
    dataClassifications: definition.dataClassifications || ["public", "internal", "private"],
    execute: definition.execute,
  });
}

function getExecutor(type, version) {
  const key = type + (version ? "@" + version : "");
  if (version) return EXECUTORS.get(key) || null;
  for (const [k, v] of EXECUTORS) {
    if (k.startsWith(type + "@")) return v;
  }
  return null;
}

function listExecutors({ capability, platform } = {}) {
  let executors = Array.from(EXECUTORS.values());
  if (capability) executors = executors.filter(e => e.capabilities.includes(capability));
  if (platform) executors = executors.filter(e => e.platforms.includes(platform));
  return executors.map(e => ({
    type: e.type,
    version: e.version,
    description: e.description,
    risk: e.risk,
    capabilities: e.capabilities,
    platforms: e.platforms,
    resourceLimits: e.resourceLimits,
    timeout: e.timeout,
    dataClassifications: e.dataClassifications,
  }));
}

function canExecute(type, platform, dataClassification) {
  const executor = getExecutor(type);
  if (!executor) return false;
  if (!executor.platforms.includes(platform)) return false;
  if (!executor.dataClassifications.includes(dataClassification)) return false;
  return true;
}

async function executeJob(type, context, input) {
  const executor = getExecutor(type);
  if (!executor) throw new Error("Unknown executor: " + type);

  if (input && typeof input === "object") {
    const inputSize = JSON.stringify(input).length;
    if (inputSize > executor.maxInputSize) {
      throw new Error("Input too large: " + inputSize + " bytes (max: " + executor.maxInputSize + ")");
    }
  }

  const start = Date.now();
  try {
    const result = await Promise.race([
      executor.execute(context, input),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Executor timeout")), executor.timeout)),
    ]);
    const durationMs = Date.now() - start;
    return {
      success: true,
      result,
      durationMs,
      executorType: type,
      executorVersion: executor.version,
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      durationMs: Date.now() - start,
      executorType: type,
      executorVersion: executor.version,
    };
  }
}

function unregisterExecutor(type, version) {
  const key = type + "@" + version;
  return EXECUTORS.delete(key);
}

function isRegistered(type, version) {
  return !!getExecutor(type, version);
}

const builtinExecutors = [
  {
    type: "model.benchmark",
    version: "1",
    description: "Run a bounded benchmark against a model or provider",
    risk: "low",
    capabilities: ["benchmark"],
    platforms: ["linux", "darwin", "win32"],
    inputSchema: { model: "string", prompt: "string", maxTokens: "number" },
    outputSchema: { tokensPerSecond: "number", latencyMs: "number" },
    resourceLimits: { maxConcurrent: 2, memoryBytes: 512 * 1024 * 1024 },
    timeout: 120000,
    dataClassifications: ["public", "internal"],
    async execute(context, input) {
      const start = Date.now();
      const prompt = input.prompt || "Hello, respond with a short greeting.";
      const maxTokens = input.maxTokens || 100;
      if (context.inference) {
        const result = await context.inference.generate(prompt, {
          model: input.model,
          maxTokens,
          temperature: 0.7,
        });
        const durationMs = Date.now() - start;
        const tokens = result.content?.split(/\s+/).length || 0;
        return {
          providerId: result.providerId,
          modelId: result.modelId,
          durationMs,
          tokensEstimate: tokens,
          tokensPerSecond: tokens / (durationMs / 1000),
          content: result.content?.substring(0, 200),
        };
      }
      return { durationMs: Date.now() - start, tokensEstimate: 0, content: "No inference service available" };
    },
  },
];

for (const def of builtinExecutors) {
  try { registerExecutor(def); } catch {}
}

// Register the OpenVINO text-embedding executor definition so the registry is
// the single authoritative source of executor metadata (type/version/platform/
// limits) instead of a duplicated, hand-maintained descriptor. Loading this
// module has no side effects (no helper spawn); initialisation stays explicit.
try {
  const { OPENVINO_EXECUTOR_DEFINITION } = require("./openvino-executor");
  registerExecutor(OPENVINO_EXECUTOR_DEFINITION);
} catch { /* optional; absent or already registered */ }

module.exports = {
  registerExecutor,
  getExecutor,
  listExecutors,
  canExecute,
  executeJob,
  unregisterExecutor,
  isRegistered,
};
