const providerRegistry = require("./provider-registry");
const modelRegistry = require("./model-registry");
const capabilityRouter = require("./capability-router");
const healthMonitor = require("./health-monitor");
const { ComputeError, ProviderUnavailableError, RoutingError } = require("./errors");

class InferenceService {
  constructor() {
    this._adapterCache = new Map();
  }

  _getAdapter(provider) {
    const cacheKey = provider.providerId + ":" + provider.endpoint;
    if (this._adapterCache.has(cacheKey)) return this._adapterCache.get(cacheKey);
    let adapter;
    if (provider.providerType === "ollama") {
      const OllamaProvider = require("../providers/ollama-provider");
      adapter = new OllamaProvider({ endpoint: provider.endpoint, name: provider.displayName });
    } else if (provider.providerType === "openai-compatible") {
      const OpenAICompatibleProvider = require("../providers/openai-compatible-provider");
      adapter = new OpenAICompatibleProvider({ endpoint: provider.endpoint, name: provider.displayName });
    } else if (provider.providerType === "mock") {
      const MockProvider = require("../providers/mock-provider");
      adapter = new MockProvider({ name: provider.displayName });
    } else {
      throw new ProviderUnavailableError(provider.providerId, "unsupported_type");
    }
    this._adapterCache.set(cacheKey, adapter);
    return adapter;
  }

  clearAdapterCache() { this._adapterCache.clear(); }

  async chat(request, context = {}) {
    const { provider, model } = capabilityRouter.selectProvider({
      capability: "chat",
      requiresTools: request.requiresTools,
      requiresVision: request.requiresVision,
      contextLimit: request.contextLimit,
      dataClassification: request.dataClassification,
      workloadClass: request.workloadClass,
      trustLevel: request.trustLevel,
      preferences: request.preferences,
    });
    if (!provider || !model) {
      throw new RoutingError("No provider available for chat request", {
        capability: "chat", dataClassification: request.dataClassification,
      });
    }
    return this._executeWithFallback({
      capability: "chat",
      operation: "chat",
      provider, model,
      payload: {
        messages: request.messages,
        model: model.providerModelName,
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens,
        tools: request.tools,
        format: request.format,
        contextLimit: request.contextLimit,
      },
      request,
      context,
    });
  }

  async generate(prompt, request = {}, context = {}) {
    const { provider, model } = capabilityRouter.selectProvider({
      capability: "generate",
      dataClassification: request.dataClassification,
      workloadClass: request.workloadClass,
      trustLevel: request.trustLevel,
      preferences: request.preferences,
    });
    if (!provider || !model) {
      throw new RoutingError("No provider available for generate request");
    }
    return this._executeWithFallback({
      capability: "generate",
      operation: "generate",
      provider, model,
      payload: {
        prompt,
        model: model.providerModelName,
        system: request.system,
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens,
        contextLimit: request.contextLimit,
      },
      request,
      context,
    });
  }

  async embed(request, context = {}) {
    const { provider, model } = capabilityRouter.selectProvider({
      capability: "embeddings",
      requiresEmbedding: true,
      dataClassification: request.dataClassification,
      workloadClass: request.workloadClass,
      trustLevel: request.trustLevel,
    });
    if (!provider || !model) {
      throw new RoutingError("No provider available for embedding request");
    }
    const adapter = this._getAdapter(provider);
    const start = Date.now();
    try {
      const result = await adapter.embed(request.input, {
        model: model.providerModelName,
        dimensions: request.dimensions,
        timeout: request.timeout,
      });
      const durationMs = Date.now() - start;
      this._recordMetric("embedding_latency", durationMs, { providerId: provider.providerId, modelId: model.modelId });
      return {
        ...result,
        providerId: provider.providerId,
        modelId: model.modelId,
        durationMs,
      };
    } catch (e) {
      providerRegistry.updateHealth(provider.providerId, { status: "unreachable", error: e.message, success: false });
      throw e;
    }
  }

  async listModels(query = {}, context = {}) {
    const results = [];
    const providers = providerRegistry.listProviders({ enabled: true });
    for (const provider of providers) {
      if (provider.health.circuitState === "open") continue;
      try {
        const adapter = this._getAdapter(provider);
        const models = await adapter.listModels();
        results.push({
          providerId: provider.providerId,
          providerType: provider.providerType,
          displayName: provider.displayName,
          models: models.map(m => ({
            name: m.name,
            providerId: provider.providerId,
            size: m.size,
            details: m.details,
          })),
        });
      } catch {
        results.push({
          providerId: provider.providerId,
          providerType: provider.providerType,
          displayName: provider.displayName,
          models: [],
          error: "Failed to list models",
        });
      }
    }
    return results;
  }

  async getProviderHealth(providerId) {
    const provider = providerRegistry.getProvider(providerId);
    if (!provider) return null;
    const result = await healthMonitor.checkNow(providerId);
    return { ...provider.health, checkResult: result };
  }

  async _executeWithFallback({ capability, operation, provider, model, payload, request, context }) {
    const fallbackHistory = [];
    let lastError;
    const providers = [provider, ...(capabilityRouter.selectWithFallback({
      capability,
      dataClassification: request.dataClassification,
      requiresVision: request.requiresVision,
      requiresTools: request.requiresTools,
      requiresEmbedding: request.requiresEmbedding,
      contextLimit: request.contextLimit,
    }).fallbacks || []).map(f => f.provider)];

    for (const p of providers) {
      try {
        const adapter = this._getAdapter(p);
        const start = Date.now();
        let result;
        if (operation === "chat") {
          result = await adapter.chat(payload.messages, {
            model: payload.model,
            temperature: payload.temperature,
            maxTokens: payload.maxTokens,
            tools: payload.tools,
            format: payload.format,
            contextLimit: payload.contextLimit,
          });
        } else if (operation === "generate") {
          result = await adapter.generate(payload.prompt, {
            model: payload.model,
            system: payload.system,
            temperature: payload.temperature,
            maxTokens: payload.maxTokens,
            contextLimit: payload.contextLimit,
          });
        }
        const durationMs = Date.now() - start;
        providerRegistry.updateHealth(p.providerId, { status: "healthy", success: true });
        this._recordMetric(operation + "_latency", durationMs, { providerId: p.providerId, modelId: model.modelId });
        return {
          ...result,
          providerId: p.providerId,
          providerType: p.providerType,
          modelId: model.modelId,
          durationMs,
          fallback: fallbackHistory.length > 0,
          fallbackHistory,
        };
      } catch (e) {
        lastError = e;
        providerRegistry.updateHealth(p.providerId, { status: "unreachable", error: e.message, success: false });
        fallbackHistory.push({ providerId: p.providerId, reason: e.message });
        if (!request.preferences?.allowFallback) break;
      }
    }
    throw new ComputeError(
      `All providers failed for ${capability}: ${lastError?.message}`,
      "ALL_PROVIDERS_FAILED",
      { fallbackHistory }
    );
  }

  _recordMetric(type, value, tags = {}) {
    try {
      const dbStore = require("../db");
      const db = dbStore.getDb();
      db.prepare(`
        INSERT INTO compute_metrics (metric_type, provider_id, model_id, value, tags_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(type, tags.providerId || null, tags.modelId || null, value, JSON.stringify(tags));
    } catch {}
  }
}

module.exports = new InferenceService();
