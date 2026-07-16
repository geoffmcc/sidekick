const providerRegistry = require("./provider-registry");
const modelRegistry = require("./model-registry");
const { RoutingError, DataClassificationError, TrustViolationError, CIRCUIT_STATES, DATA_CLASSIFICATIONS, TRUST_LEVELS, WORKLOAD_CLASSES } = require("./errors");

const TRUST_ORDER = { untrusted: 0, limited: 1, trusted: 2, privileged: 3 };

class CapabilityRouter {
  constructor() {
    this._routingRules = [];
  }

  matchRoutingRule(request) {
    const dbStore = require("../db");
    try {
      const db = dbStore.getDb();
      const rows = db.prepare("SELECT * FROM compute_routing_rules WHERE enabled = 1 ORDER BY priority DESC").all();
      for (const row of rows) {
        if (this._matchesRule(row, request)) {
          return {
            ruleId: row.rule_id,
            ruleName: row.rule_name,
            preferredProviders: JSON.parse(row.preferred_provider_ids_json || "[]"),
            preferredModels: JSON.parse(row.preferred_model_ids_json || "[]"),
            preferredWorkers: JSON.parse(row.preferred_worker_ids_json || "[]"),
            fallbackProviders: JSON.parse(row.fallback_provider_ids_json || "[]"),
            maxLatencyMs: row.max_latency_ms,
          };
        }
      }
    } catch {}
    return null;
  }

  _matchesRule(rule, request) {
    if (rule.workload_class && rule.workload_class !== request.workloadClass) return false;
    if (rule.capability_filter && !request.capability?.includes(rule.capability_filter)) return false;
    if (rule.data_classification_filter && rule.data_classification_filter !== request.dataClassification) return false;
    if (rule.trust_level_min) {
      const minTrust = TRUST_ORDER[rule.trust_level_min] || 0;
      if ((TRUST_ORDER[request.trustLevel] || 0) < minTrust) return false;
    }
    if (rule.require_vision && !request.requiresVision) return false;
    if (rule.require_tools && !request.requiresTools) return false;
    if (rule.require_embedding && !request.requiresEmbedding) return false;
    return true;
  }

  selectProvider(request) {
    const { capability, dataClassification, requiresVision, requiresTools, requiresEmbedding,
      contextLimit, workloadClass, preferences = {} } = request;

    let candidates = providerRegistry.listProviders({ enabled: true });
    candidates = candidates.filter(p => {
      if (p.health.circuitState === CIRCUIT_STATES.OPEN) return false;
      if (p.health.status === "disabled" || p.health.status === "maintenance") return false;
      if (dataClassification && !p.dataClassifications.includes(dataClassification)) return false;
      return true;
    });

    if (candidates.length === 0) return { provider: null, model: null, reason: "No available providers" };

    const rule = this.matchRoutingRule(request);
    if (rule && rule.preferredProviders.length > 0) {
      const preferred = candidates.filter(p => rule.preferredProviders.includes(p.providerId));
      if (preferred.length > 0) candidates = preferred;
    }

    const scored = candidates.map(p => {
      let score = p.priority;
      if (p.health.status === "healthy") score += 20;
      else if (p.health.status === "degraded") score -= 10;
      if (p.health.failureCount > 0) score -= p.health.failureCount * 5;
      if (p.health.circuitState === CIRCUIT_STATES.HALF_OPEN) score -= 15;
      if (workloadClass && p.mode === "worker") score += 5;
      return { provider: p, score };
    });

    scored.sort((a, b) => b.score - a.score);

    for (const { provider } of scored) {
      const models = modelRegistry.listModels({ providerId: provider.providerId, enabled: true });
      const matchingModels = models.filter(m => {
        if (m.deprecated) return false;
        if (requiresTools && !m.supportsTools) return false;
        if (requiresVision && !m.supportsVision) return false;
        if (requiresEmbedding && !m.supportsEmbedding) return false;
        if (contextLimit && m.contextLimit && m.contextLimit < contextLimit) return false;
        if (capability && !m.capabilities.includes(capability)) return false;
        return true;
      });

      if (matchingModels.length > 0) {
        const rule2 = this.matchRoutingRule(request);
        if (rule2 && rule2.preferredModels.length > 0) {
          const preferred = matchingModels.filter(m => rule2.preferredModels.includes(m.modelId));
          if (preferred.length > 0) return { provider, model: preferred[0], reason: "matched_preferred_model" };
        }
        matchingModels.sort((a, b) => (b.benchmarkScore || 50) - (a.benchmarkScore || 50));
        return { provider, model: matchingModels[0], reason: "best_match" };
      }
    }

    return { provider: scored[0]?.provider || null, model: null, reason: "no_matching_model" };
  }

  selectWithFallback(request) {
    const primary = this.selectProvider(request);
    const fallbacks = [];

    if (!primary.model) {
      const allProviders = providerRegistry.listProviders({ enabled: true });
      for (const p of allProviders) {
        if (p.providerId === primary.provider?.providerId) continue;
        if (request.dataClassification && !p.dataClassifications.includes(request.dataClassification)) continue;
        const models = modelRegistry.listModels({ providerId: p.providerId, enabled: true });
        if (models.length > 0) {
          fallbacks.push({ provider: p, model: models[0], reason: "fallback" });
          break;
        }
      }
    }

    return { ...primary, fallbacks };
  }
}

module.exports = new CapabilityRouter();
