"use strict";

function createAgentCatalog({ getToolDefsForSource, getBuiltinRegistry, crypto }) {
  function getLiveAgentToolDefs() {
    return getToolDefsForSource("agent").filter(tool => tool && tool.enabled !== false);
  }

  function getLiveAgentDescriptor(name) {
    const requested = String(name || "").replace(/^sidekick_/i, "");
    const visible = getLiveAgentToolDefs().find(tool => String(tool.name || "").replace(/^sidekick_/i, "") === requested);
    if (!visible) return null;
    try { return getBuiltinRegistry().get(name) || visible; } catch { return visible; }
  }

  function liveAgentCatalogFingerprint() {
    const entries = getLiveAgentToolDefs().map(tool => {
      const descriptor = getLiveAgentDescriptor(tool.name);
      return {
        name: String(tool.name || ""),
        risk: tool.risk || descriptor?.risk || null,
        source: tool.source || descriptor?.source || null,
        version: descriptor?.version || null,
        args: tool.argumentDescriptions || tool.args || {},
        annotations: descriptor?.annotations || {},
      };
    });
    return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  }

  function getLiveAgentRegistry() {
    const visible = new Set(getLiveAgentToolDefs().map(tool => String(tool.name || "").replace(/^sidekick_/i, "")));
    return {
      version: liveAgentCatalogFingerprint(),
      get(name) { return visible.has(String(name || "").replace(/^sidekick_/i, "")) ? getLiveAgentDescriptor(name) : null; },
      toolDefs() { return getLiveAgentToolDefs(); },
    };
  }

  function getLiveAgentToolContracts() {
    const visible = getLiveAgentToolDefs();
    let registry;
    try { registry = getBuiltinRegistry(); } catch { return []; }
    return visible.map(tool => registry.get(tool.name)).filter(descriptor => descriptor && descriptor.schema && typeof descriptor.schema.safeParse === "function");
  }

  function brainAgentTools() {
    return getToolDefsForSource("agent").filter(tool => tool.enabled);
  }

  // Discovery-only projection. Preflight still resolves the live descriptor
  // and the dispatcher rechecks schema, policy and approval before execution.
  function getLiveAgentCapabilityCatalog(options = {}) {
    try {
      return require("../capabilities/catalog").project({ ...options, source: "agent", kind: options.kind || "tool" });
    } catch {
      return { ok: false, source: "agent", total: 0, offset: 0, limit: 0, has_more: false, entries: [], error: "capability catalog unavailable" };
    }
  }

  return {
    getLiveAgentToolDefs,
    getLiveAgentDescriptor,
    getLiveAgentRegistry,
    getLiveAgentToolContracts,
    liveAgentCatalogFingerprint,
    brainAgentTools,
    getLiveAgentCapabilityCatalog,
  };
}

module.exports = { createAgentCatalog };
