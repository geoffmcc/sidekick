const { requestJson } = require("../compute/provider-http");

class OpenAICompatibleProvider {
  constructor(config = {}) {
    this.type = "openai-compatible";
    this.name = config.name || "OpenAI Compatible";
    this.endpoint = config.endpoint || "https://api.openai.com/v1";
    this.apiKey = config.apiKey || "";
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
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = "Bearer " + this.apiKey;
    return requestJson({ endpoint: this.endpoint, path, method: options.method || "POST", headers, body, timeout: options.timeout || this.timeout, label: "OpenAI-compatible endpoint", errorPrefix: "OpenAI", rateLimitError: "Rate limited" });
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
