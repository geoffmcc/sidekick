const crypto = require("crypto");

class MockProvider {
  constructor(config = {}) {
    this.type = "mock";
    this.name = config.name || "Mock Provider";
    this.endpoint = config.endpoint || "mock://localhost";
    this.capabilities = ["chat", "generate", "embeddings", "model_listing"];
    this.supports = {
      chat: true,
      generate: true,
      embeddings: true,
      modelListing: true,
      modelHealth: true,
      vision: true,
      tools: false,
      structuredOutput: true,
    };
    this._callCount = 0;
    this._calls = [];
    this._responses = config.responses || {};
    this._failNext = config.failNext || 0;
    this._latencyMs = config.latencyMs || 0;
    this._models = config.models || [
      { name: "mock-small", size: 1000000, details: { parameter_size: "1B" } },
      { name: "mock-medium", size: 4000000, details: { parameter_size: "4B" } },
      { name: "mock-large", size: 8000000, details: { parameter_size: "8B" } },
      { name: "mock-embed", size: 500000, details: { parameter_size: "100M" } },
    ];
  }

  _recordCall(method, args) {
    this._callCount++;
    this._calls.push({ method, args, timestamp: Date.now() });
    if (this._calls.length > 1000) this._calls = this._calls.slice(-500);
  }

  _checkFail() {
    if (this._failNext > 0) {
      this._failNext--;
      throw new Error("Mock provider: simulated failure");
    }
  }

  getCallCount() { return this._callCount; }
  getCalls() { return [...this._calls]; }
  clearCalls() { this._callCount = 0; this._calls = []; }
  setFailNext(n) { this._failNext = n; }
  setLatency(ms) { this._latencyMs = ms; }

  async _delay() {
    if (this._latencyMs > 0) {
      return new Promise(r => setTimeout(r, this._latencyMs));
    }
  }

  async health() {
    this._recordCall("health", {});
    return { healthy: true, models: this._models.length };
  }

  async listModels() {
    this._recordCall("listModels", {});
    return this._models.map(m => ({ ...m }));
  }

  async chat(messages, options = {}) {
    await this._delay();
    this._checkFail();
    this._recordCall("chat", { messages, options });
    const response = this._responses.chat ||
      "Mock response to: " + (messages[messages.length - 1]?.content || "").substring(0, 100);
    return {
      content: typeof response === "function" ? response(messages, options) : response,
      model: options.model || "mock-medium",
      totalDuration: this._latencyMs * 1000000,
      promptEvalCount: messages.reduce((s, m) => s + (m.content?.length || 0), 0),
      evalCount: response.length || 50,
      done: true,
    };
  }

  async generate(prompt, options = {}) {
    await this._delay();
    this._checkFail();
    this._recordCall("generate", { prompt, options });
    const response = this._responses.generate ||
      "Mock generation for: " + (prompt || "").substring(0, 100);
    return {
      content: typeof response === "function" ? response(prompt, options) : response,
      model: options.model || "mock-medium",
      totalDuration: this._latencyMs * 1000000,
      done: true,
    };
  }

  async embed(input, options = {}) {
    await this._delay();
    this._checkFail();
    this._recordCall("embed", { input, options });
    const dim = options.dimensions || 384;
    const embedding = Array.from({ length: dim }, () => Math.random() * 2 - 1);
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    const normalized = embedding.map(v => v / norm);
    return {
      embedding: normalized,
      model: options.model || "mock-embed",
      dimensions: dim,
    };
  }
}

module.exports = MockProvider;
