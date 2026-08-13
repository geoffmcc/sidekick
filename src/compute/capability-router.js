const providerRegistry = require("./provider-registry");
const modelRegistry = require("./model-registry");
const { RoutingError, DataClassificationError, TrustViolationError, CIRCUIT_STATES, DATA_CLASSIFICATIONS, TRUST_LEVELS, WORKLOAD_CLASSES } = require("./errors");

// Trust ordering is IMPORTED from the placement core rather than redeclared.
// The second copy that used to live here was missing the legacy `private`
// label, which placement ranks as `trusted`, so the same provider ranked 2 in
// placement and 0 here — two selectors that both look authoritative,
// disagreeing about whether a provider is trusted at all.
const { TRUST_ORDER } = require("./placement");

// Placement treats an unspecified requirement as `trusted`; matching that
// default is what keeps `explain` from advertising a provider that real
// placement would refuse.
const DEFAULT_TRUST_REQUIRED = "trusted";

// Unknown or legacy labels rank as untrusted, fail-closed, exactly as placement does.
function trustRank(level) {
  return TRUST_ORDER[level] ?? 0;
}

function meetsTrust(provider, request) {
  const required = request.trustLevel || DEFAULT_TRUST_REQUIRED;
  return trustRank(provider.trustLevel) >= trustRank(required);
}

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
      // Trust was never compared here. Circuit state, health and data
      // classification were all enforced, so the omission looked like a
      // complete filter while `explain` could still name a provider that
      // `decidePlacement` refuses on trust grounds.
      if (!meetsTrust(p, request)) return false;
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
        // The comment below already required a fallback to satisfy the same
        // constraints as a primary candidate; trust was missing from that list,
        // which is the one constraint where falling back quietly would matter most.
        if (!meetsTrust(p, request)) continue;
        const models = modelRegistry.listModels({ providerId: p.providerId, enabled: true });
        // A fallback candidate must satisfy the SAME requirement filters as a
        // primary candidate — falling back must never mean falling below the
        // request's capability, tool/vision/embedding, or context constraints.
        const matching = models.filter(m => {
          if (m.deprecated) return false;
          if (request.requiresTools && !m.supportsTools) return false;
          if (request.requiresVision && !m.supportsVision) return false;
          if (request.requiresEmbedding && !m.supportsEmbedding) return false;
          if (request.contextLimit && m.contextLimit && m.contextLimit < request.contextLimit) return false;
          if (request.capability && !m.capabilities.includes(request.capability)) return false;
          return true;
        });
        if (matching.length > 0) {
          fallbacks.push({ provider: p, model: matching[0], reason: "fallback" });
          break;
        }
      }
    }

    return { ...primary, fallbacks };
  }
}

module.exports = new CapabilityRouter();
