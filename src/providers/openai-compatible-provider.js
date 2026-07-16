const https = require("https");
const http = require("http");

class OpenAICompatibleProvider {
  constructor(config = {}) {
    this.type = "openai-compatible";
    this.name = config.name || "OpenAI Compatible";
    this.endpoint = config.endpoint || "https://api.openai.com/v1";
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
    this.timeout = config.timeout || 60000;
    this.capabilities = ["chat", "embeddings", "model_listing"];
    this.supports = {
      chat: true,
      generate: false,
      embeddings: true,
      modelListing: true,
      modelHealth: true,
      vision: true,
      tools: true,
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
      if (this.apiKey) headers["Authorization"] = "Bearer " + this.apiKey;
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
          if (res.statusCode === 429) {
            return reject(new Error("Rate limited"));
          }
          if (res.statusCode >= 400) {
            let errMsg;
            try { errMsg = JSON.parse(data); } catch { errMsg = { error: { message: data.substring(0, 200) } }; }
            return reject(new Error("OpenAI " + res.statusCode + ": " + (errMsg.error?.message || data.substring(0, 200))));
          }
          try { resolve(JSON.parse(data)); } catch { reject(new Error("Parse error")); }
        });
      });
      req.setTimeout(options.timeout || this.timeout, () => { req.destroy(); reject(new Error("Timeout")); });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async health() {
    try {
      const result = await this._request("/models", null, { method: "GET", timeout: 10000 });
      return { healthy: true, models: result.data?.length || 0 };
    } catch (e) {
      return { healthy: false, error: e.message };
    }
  }

  async listModels() {
    const result = await this._request("/models", null, { method: "GET" });
    return (result.data || []).map(m => ({
      name: m.id,
      owned_by: m.owned_by,
      created: m.created,
    }));
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
    };
    if (options.tools) body.tools = options.tools;
    if (options.responseFormat) body.response_format = options.responseFormat;
    const result = await this._request("/chat/completions", body, { timeout: options.timeout || this.timeout });
    const choice = result.choices?.[0];
    return {
      content: choice?.message?.content || "",
      toolCalls: choice?.message?.tool_calls || null,
      finishReason: choice?.finish_reason,
      model: result.model,
      usage: result.usage || {},
    };
  }

  async embed(input, options = {}) {
    const body = {
      model: options.model || "text-embedding-3-small",
      input: typeof input === "string" ? input : [input],
    };
    const result = await this._request("/embeddings", body, { timeout: options.timeout || 30000 });
    const item = result.data?.[0];
    return {
      embedding: item?.embedding || [],
      model: result.model,
      dimensions: item?.embedding?.length || 0,
      usage: result.usage || {},
    };
  }
}

module.exports = OpenAICompatibleProvider;
