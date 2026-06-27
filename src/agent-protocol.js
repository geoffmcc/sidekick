function collectActionArguments(decision) {
  if (decision.arguments && typeof decision.arguments === "object") return decision.arguments;
  if (decision.args && typeof decision.args === "object") return decision.args;

  const ignored = new Set(["action", "tool", "arguments", "args", "done", "result", "think", "thought"]);
  return Object.fromEntries(
    Object.entries(decision).filter(([key]) => !ignored.has(key))
  );
}

function normalizeDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;

  if (typeof decision.tool === "string" && decision.tool) {
    return { tool: decision.tool, arguments: collectActionArguments(decision) };
  }

  if (typeof decision.action === "string" && decision.action.startsWith("sidekick_")) {
    return { tool: decision.action, arguments: collectActionArguments(decision) };
  }

  if (decision.done === true || decision.action === "done") {
    return { done: true, result: decision.result || decision.text || "Task completed" };
  }

  if (typeof decision.think === "string") return { think: decision.think };
  if (typeof decision.thought === "string") return { think: decision.thought };
  return null;
}

function jsonCandidates(text) {
  const trimmed = String(text || "").trim();
  const candidates = [];
  if (trimmed) candidates.push(trimmed);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  return [...new Set(candidates)];
}

function parseAgentDecision(text) {
  for (const candidate of jsonCandidates(text)) {
    try {
      const normalized = normalizeDecision(JSON.parse(candidate));
      if (normalized) return normalized;
    } catch {}
  }
  return { think: String(text || "").trim() };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function decisionFingerprint(decision) {
  if (decision?.think) return "think:" + decision.think.replace(/\s+/g, " ").trim();
  return JSON.stringify(canonicalize(decision));
}

function trackDecisionRepetition(state, decision) {
  const fingerprint = decisionFingerprint(decision);
  const repeats = fingerprint === state.fingerprint ? state.repeats + 1 : 0;
  return {
    fingerprint,
    repeats,
    repeated: repeats > 0,
    abort: repeats >= 2
  };
}

function selectBestModelName(modelNames, configuredModel = "") {
  if (configuredModel) return configuredModel;
  const names = modelNames.map(name => name.toLowerCase());
  const priorities = [
    "llama3.1",
    "llama3",
    "qwen2.5",
    "mistral",
    "gemma",
    "phi3",
    "deepseek-coder",
    "qwen2.5-coder",
    "codellama",
    "starcoder"
  ];
  for (const preferred of priorities) {
    const found = names.find(name => name.includes(preferred));
    if (found) return found;
  }
  return names[0] || "phi3:mini";
}

function buildChatMessages(systemPrompt, messages) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map(message => ({
      role: ["system", "assistant", "user"].includes(message.role) ? message.role : "user",
      content: message.content
    }))
  ];
}

module.exports = {
  normalizeDecision,
  parseAgentDecision,
  decisionFingerprint,
  trackDecisionRepetition,
  selectBestModelName,
  buildChatMessages
};
