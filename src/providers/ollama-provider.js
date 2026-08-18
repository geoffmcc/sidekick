const { requestJson } = require("../compute/provider-http");
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

// Drop keys whose value is undefined so optional generation options
// (num_ctx/num_predict) are omitted rather than sent as null.
function pruneUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

class OllamaProvider {
  constructor(config = {}) {
    this.type = "ollama";
    this.name = config.name || "Ollama";
    this.endpoint = config.endpoint || process.env.OLLAMA_URL || "http://127.0.0.1:11434";
    this.timeout = config.timeout || 300000;
    this.capabilities = ["chat", "generate", "embeddings", "model_listing", "model_health"];
    this.supports = {
      chat: true,
      generate: true,
      embeddings: true,
      modelListing: true,
      modelHealth: true,
      modelLoading: true,
      vision: true,
      tools: false,
      structuredOutput: true,
    };
  }

  _request(path, body, options = {}) {
    return requestJson({ endpoint: this.endpoint, path, method: options.method || "POST", headers: { "Content-Type": "application/json" }, body, timeout: options.timeout || this.timeout, label: "Ollama endpoint", errorPrefix: "Ollama" });
  }

  async health() {
    try {
      const result = await this._request("/api/tags", null, { method: "GET", timeout: 5000 });
      return { healthy: true, models: (result.models || []).length };
    } catch (e) {
      return { healthy: false, error: e.message };
    }
  }

  async listModels() {
    const result = await this._request("/api/tags", null, { method: "GET" });
    return (result.models || []).map(m => ({
      name: m.name,
      size: m.size,
      digest: m.digest,
      modifiedAt: m.modified_at,
      details: m.details || {},
    }));
  }

  async getModelInfo(modelName) {
    return this._request("/api/show", { name: modelName });
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model,
      messages,
      stream: false,
      // Reasoning models such as qwen3.5 can spend a bounded planner budget
      // entirely in hidden thinking and return no visible JSON. Keep thinking
      // opt-in so structured Compute requests receive usable content by
      // default; callers can still explicitly request it.
      think: options.think === undefined ? false : Boolean(options.think),
      options: pruneUndefined({
        temperature: options.temperature ?? 0.7,
        num_ctx: options.contextLimit,
        // Use a large finite budget by default. Ollama's -1 is unbounded and
        // can leave reasoning models running indefinitely; callers may still
        // provide an explicit maxTokens value.
        num_predict: options.maxTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : options.maxTokens,
      }),
    };
    if (options.format) body.format = options.format;
    const result = await this._request("/api/chat", body, { timeout: options.timeout || this.timeout });
    return {
      content: result.message?.content || "",
      model: result.model,
      totalDuration: result.total_duration,
      loadDuration: result.load_duration,
      promptEvalCount: result.prompt_eval_count,
      evalCount: result.eval_count,
      done: result.done,
      // "length" means num_predict truncated the answer. Callers need this to
      // tell a truncated response apart from an empty one.
      finishReason: result.done_reason,
    };
  }

  async generate(prompt, options = {}) {
    const body = {
      model: options.model,
      prompt,
      system: options.system,
      stream: false,
      // Same rationale as chat(): reasoning models can spend the whole output
      // budget in hidden thinking and return an empty response. Thinking is
      // opt-in on both entry points so they cannot drift apart.
      think: options.think === undefined ? false : Boolean(options.think),
      options: pruneUndefined({
        temperature: options.temperature ?? 0.7,
        num_ctx: options.contextLimit,
        num_predict: options.maxTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : options.maxTokens,
      }),
    };
    const result = await this._request("/api/generate", body, { timeout: options.timeout || this.timeout });
    return {
      content: result.response || "",
      model: result.model,
      totalDuration: result.total_duration,
      promptEvalCount: result.prompt_eval_count,
      evalCount: result.eval_count,
      done: result.done,
      finishReason: result.done_reason,
    };
  }

  async embed(input, options = {}) {
    const body = {
      model: options.model || "nomic-embed-text",
      prompt: typeof input === "string" ? input : input.join("\n"),
    };
    const result = await this._request("/api/embeddings", body, { timeout: options.timeout || 30000 });
    return {
      embedding: result.embedding || [],
      model: body.model,
      dimensions: result.embedding?.length || 0,
    };
  }

  async pullModel(modelName) {
    return this._request("/api/pull", { name: modelName, stream: false }, { timeout: 600000 });
  }

  async loadedModels() {
    const result = await this._request("/api/ps", null, { method: "GET" });
    return result.models || [];
  }
}

module.exports = OllamaProvider;
