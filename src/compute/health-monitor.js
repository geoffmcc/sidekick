const providerRegistry = require("./provider-registry");
const modelRegistry = require("./model-registry");

class HealthMonitor {
  constructor() {
    this._intervals = new Map();
    this._defaultInterval = 30000;
  }

  start(providerId, intervalMs) {
    if (this._intervals.has(providerId)) return;
    const interval = intervalMs || this._defaultInterval;
    const check = async () => {
      try {
        const provider = providerRegistry.getProvider(providerId);
        if (!provider || !provider.enabled) { this.stop(providerId); return; }
        const adapter = this._getAdapter(provider);
        if (!adapter) return;
        const result = await adapter.health();
        providerRegistry.updateHealth(providerId, {
          status: result.healthy ? "healthy" : "unreachable",
          error: result.error || null,
          success: result.healthy,
        });
      } catch (e) {
        providerRegistry.updateHealth(providerId, {
          status: "unreachable",
          error: e.message,
          success: false,
        });
      }
    };
    check();
    this._intervals.set(providerId, setInterval(check, interval));
  }

  stop(providerId) {
    const timer = this._intervals.get(providerId);
    if (timer) { clearInterval(timer); this._intervals.delete(providerId); }
  }

  stopAll() {
    for (const [id] of this._intervals) this.stop(id);
  }

  _getAdapter(provider) {
    try {
      if (provider.providerType === "ollama") {
        const OllamaProvider = require("../providers/ollama-provider");
        return new OllamaProvider({ endpoint: provider.endpoint });
      }
      if (provider.providerType === "openai-compatible") {
        const OpenAICompatibleProvider = require("../providers/openai-compatible-provider");
        return new OpenAICompatibleProvider({ endpoint: provider.endpoint });
      }
    } catch { return null; }
    return null;
  }

  async checkNow(providerId) {
    const provider = providerRegistry.getProvider(providerId);
    if (!provider) return null;
    const adapter = this._getAdapter(provider);
    if (!adapter) return { healthy: false, error: "No adapter for provider type" };
    try {
      const result = await adapter.health();
      providerRegistry.updateHealth(providerId, {
        status: result.healthy ? "healthy" : "unreachable",
        error: result.error || null,
        success: result.healthy,
      });
      return result;
    } catch (e) {
      providerRegistry.updateHealth(providerId, {
        status: "unreachable",
        error: e.message,
        success: false,
      });
      return { healthy: false, error: e.message };
    }
  }

  getStatus() {
    const providers = providerRegistry.listProviders({ enabled: true });
    return providers.map(p => ({
      providerId: p.providerId,
      name: p.displayName,
      type: p.providerType,
      health: p.health.status,
      lastCheck: p.health.lastCheck,
      failureCount: p.health.failureCount,
      circuitState: p.health.circuitState,
    }));
  }
}

module.exports = new HealthMonitor();
