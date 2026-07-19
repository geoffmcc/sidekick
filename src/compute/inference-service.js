const providerRegistry = require("./provider-registry");
const healthMonitor = require("./health-monitor");
const placement = require("./placement");
const { ComputeError, ProviderUnavailableError, RoutingError } = require("./errors");

/**
 * Direct-inference execution over registered providers. Candidate selection is
 * delegated to the shared placement core (src/compute/placement.js) so this
 * path and the distributed job path evaluate providers/models/trust/data
 * classification with the same predicates. This service keeps only execution
 * mechanics: adapter dispatch, health accounting, metrics, bounded fallback.
 *
 * Data classification is mandatory at the placement layer; requests that do
 * not specify one are treated as "private" (the most restrictive default in
 * routine use) rather than bypassing classification filtering.
 */
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

  _placementRequest(capability, request) {
    return placement.validatePlacementRequest({
      version: 1,
      capability,
      data_classification: request.dataClassification || "private",
      trust_level_required: request.trustLevel || "trusted",
      ...(request.workloadClass ? { workload_class: request.workloadClass } : {}),
      requirements: {
        ...(request.requiresTools ? { tools: true } : {}),
        ...(request.requiresVision ? { vision: true } : {}),
        ...(request.requiresStructuredOutput ? { structured_output: true } : {}),
        ...(Number.isInteger(request.contextLimit) ? { context_limit: request.contextLimit } : {}),
        ...(Number.isInteger(request.dimensions) ? { dimensions: request.dimensions } : {}),
      },
      preferences: {
        allow_fallback: request.preferences?.allowFallback !== false && request.preferences?.allow_fallback !== false,
      },
    });
  }

  _selectCandidates(capability, request) {
    const validated = this._placementRequest(capability, request);
    const { eligible } = placement.rankProviderCandidates(validated);
    if (eligible.length === 0) {
      throw new RoutingError(`No provider available for ${capability} request`, {
        capability, dataClassification: validated.dataClassification,
      });
    }
    return { validated, candidates: eligible };
  }

  async chat(request, context = {}) {
    const { validated, candidates } = this._selectCandidates("chat", request);
    return this._executeWithFallback({
      capability: "chat",
      operation: "chat",
      candidates,
      allowFallback: validated.preferences.allowFallback,
      payload: {
        messages: request.messages,
        system: request.system,
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens,
        tools: request.tools,
        format: request.format,
        contextLimit: request.contextLimit,
      },
      context,
    });
  }

  async generate(prompt, request = {}, context = {}) {
    const { validated, candidates } = this._selectCandidates("generate", request);
    return this._executeWithFallback({
      capability: "generate",
      operation: "generate",
      candidates,
      allowFallback: validated.preferences.allowFallback,
      payload: {
        prompt,
        system: request.system,
        temperature: request.temperature ?? 0.7,
        maxTokens: request.maxTokens,
        contextLimit: request.contextLimit,
      },
      context,
    });
  }

  async embed(request, context = {}) {
    const embedRequest = { ...request, requiresEmbedding: true };
    const { validated, candidates } = this._selectCandidates("embeddings", embedRequest);
    return this._executeWithFallback({
      capability: "embeddings",
      operation: "embed",
      candidates,
      allowFallback: validated.preferences.allowFallback,
      payload: {
        input: request.input,
        dimensions: request.dimensions,
        timeout: request.timeout,
      },
      context,
    });
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

  /**
   * Execute against placement-ranked candidates in order. All candidates have
   * already passed the shared gates (capability, classification, trust,
   * circuit, requirement flags) — a fallback candidate is never a
   * less-validated candidate. Policy/validation failures never reach here;
   * only transient execution failures trigger fallback, and only when the
   * request allows it.
   */
  async _executeWithFallback({ capability, operation, candidates, allowFallback, payload, context }) {
    const fallbackHistory = [];
    let lastError;
    for (const candidate of candidates) {
      const { provider, model } = candidate;
      try {
        const adapter = this._getAdapter(provider);
        const start = Date.now();
        let result;
        if (operation === "chat") {
          // Adapters take the system prompt as a leading system-role message
          // (Ollama /api/chat and OpenAI-compatible /chat/completions both
          // honor it). Never override a caller-supplied leading system message.
          const messages = payload.system && payload.messages?.[0]?.role !== "system"
            ? [{ role: "system", content: payload.system }, ...payload.messages]
            : payload.messages;
          result = await adapter.chat(messages, {
            model: model.providerModelName,
            temperature: payload.temperature,
            maxTokens: payload.maxTokens,
            tools: payload.tools,
            format: payload.format,
            contextLimit: payload.contextLimit,
          });
        } else if (operation === "generate") {
          result = await adapter.generate(payload.prompt, {
            model: model.providerModelName,
            system: payload.system,
            temperature: payload.temperature,
            maxTokens: payload.maxTokens,
            contextLimit: payload.contextLimit,
          });
        } else if (operation === "embed") {
          result = await adapter.embed(payload.input, {
            model: model.providerModelName,
            dimensions: payload.dimensions,
            timeout: payload.timeout,
          });
        }
        const durationMs = Date.now() - start;
        providerRegistry.updateHealth(provider.providerId, { status: "healthy", success: true });
        this._recordMetric(operation + "_latency", durationMs, { providerId: provider.providerId, modelId: model.modelId });
        return {
          ...result,
          providerId: provider.providerId,
          providerType: provider.providerType,
          modelId: model.modelId,
          durationMs,
          fallback: fallbackHistory.length > 0,
          fallbackHistory,
          // Provenance honesty: provider execution cannot attest a device.
          // GPU-backed providers are an expectation, never a verified fact.
          acceleratorVerification: "not_verified",
        };
      } catch (e) {
        lastError = e;
        providerRegistry.updateHealth(provider.providerId, { status: "unreachable", error: e.message, success: false });
        fallbackHistory.push({ providerId: provider.providerId, modelId: model.modelId, reason: e.message });
        if (!allowFallback) break;
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
