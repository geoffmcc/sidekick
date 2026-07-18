const http = require("http");
const https = require("https");

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
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.endpoint);
      const isHttps = url.protocol === "https:";
      const mod = isHttps ? https : http;
      const bodyStr = body ? JSON.stringify(body) : null;
      const headers = { "Content-Type": "application/json" };
      if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

      const req = mod.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method || "POST",
        headers,
      }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          if (res.statusCode >= 400) {
            let errMsg;
            try { errMsg = JSON.parse(data); } catch { errMsg = { error: data.substring(0, 200) }; }
            return reject(new Error("Ollama " + res.statusCode + ": " + (errMsg.error || data.substring(0, 200))));
          }
          try { resolve(JSON.parse(data)); } catch { reject(new Error("Ollama parse error")); }
        });
      });
      req.setTimeout(options.timeout || this.timeout, () => { req.destroy(); reject(new Error("Ollama timeout")); });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
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
      options: pruneUndefined({
        temperature: options.temperature ?? 0.7,
        num_ctx: options.contextLimit,
        num_predict: options.maxTokens,
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
    };
  }

  async generate(prompt, options = {}) {
    const body = {
      model: options.model,
      prompt,
      system: options.system,
      stream: false,
      options: pruneUndefined({
        temperature: options.temperature ?? 0.7,
        num_ctx: options.contextLimit,
        num_predict: options.maxTokens,
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
