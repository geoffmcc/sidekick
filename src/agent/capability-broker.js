"use strict";

// The broker is a discovery aid, not an authorization layer.  Its input is
// the already source-filtered canonical registry and its output only shapes a
// bounded model prompt.  The dispatcher performs the authoritative lookup,
// schema validation, policy check, approval check, audit and execution again.

const STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "this", "that", "what", "which",
  "where", "when", "how", "can", "could", "would", "should", "please",
  "use", "using", "check", "show", "tell", "about", "into", "have",
  "has", "are", "is", "any", "currently", "right", "now", "my", "me",
]);

const GENERIC_EVIDENCE_TOOLS = new Set([
  "health", "status", "tail", "log_query", "metrics", "service", "find",
  "read", "list", "get", "search", "git", "llm", "respond",
]);

const MAX_TEXT = 600;

function boundedText(value, max = MAX_TEXT) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function tokens(value) {
  return new Set(
    boundedText(value, 2000).toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[^a-z0-9]+/).filter(word => word.length > 2 && !STOP_WORDS.has(word))
  );
}

function overlaps(query, candidate) {
  if (query === candidate) return true;
  const prefixLength = Math.min(4, query.length, candidate.length);
  return prefixLength >= 4 && query.slice(0, prefixLength) === candidate.slice(0, prefixLength);
}

function capabilityText(definition, metadata) {
  const parts = [
    definition.name,
    definition.description,
    definition.category,
    definition.family,
    ...(Array.isArray(definition.capabilities) ? definition.capabilities : []),
  ];
  const extra = metadata && metadata[definition.name];
  if (extra) parts.push(extra.domain, extra.description, ...(extra.terms || []));
  return boundedText(parts.filter(Boolean).join(" "), 3000);
}

/**
 * Return a deterministic, bounded shortlist from the canonical Agent-visible
 * catalog.  Metadata is declarative and bounded; it can improve relevance but
 * can never add a tool or grant authority.
 */
function discoverCapabilities(goal, definitions, { limit = 24, metadata = {} } = {}) {
  const query = tokens(goal);
  const scored = (definitions || []).filter(def => def && def.enabled !== false && typeof def.name === "string").map(def => {
    const haystack = tokens(capabilityText(def, metadata));
    let score = 0;
    for (const word of query) if ([...haystack].some(candidate => overlaps(word, candidate))) score += 1;
    return { def, score };
  });
  // A registered capability often exposes a small family of sibling tools.
  // Once one sibling matches the request, retain that namespace as a bounded
  // discovery unit. This is generic registry behavior, not knowledge of any
  // particular pack or product.
  const matchedNamespaces = new Set(scored.filter(item => item.score > 0).map(item => {
    const match = item.def.name.match(/^([a-z][a-z0-9]*)_/);
    return match ? match[1] : null;
  }).filter(Boolean));
  for (const item of scored) {
    const match = item.def.name.match(/^([a-z][a-z0-9]*)_/);
    if (item.score === 0 && match && matchedNamespaces.has(match[1])) item.score = 0.5;
  }
  scored.sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name));
  const positive = scored.filter(item => item.score > 0);
  const fallback = scored.filter(item => !positive.includes(item));
  fallback.sort((a, b) => {
    const ac = GENERIC_EVIDENCE_TOOLS.has(a.def.name.replace(/^sidekick_/, "")) ? 0 : 1;
    const bc = GENERIC_EVIDENCE_TOOLS.has(b.def.name.replace(/^sidekick_/, "")) ? 0 : 1;
    return ac - bc || a.def.name.localeCompare(b.def.name);
  });
  return [...positive, ...fallback].slice(0, Math.max(1, Math.min(64, Number(limit) || 24))).map(item => item.def);
}

function buildAgentCapabilityMetadata({ packs = [], modules = [] } = {}) {
  const moduleByName = new Map((modules || []).map(module => [module.name, module]));
  const metadata = {};
  for (const pack of packs || []) {
    if (!pack || pack.state !== "enabled") continue;
    const manifest = pack.manifest && typeof pack.manifest === "object" ? pack.manifest : {};
    const packTerms = [pack.name, pack.display_name, pack.description];
    for (const ref of manifest.modules || []) {
      const module = moduleByName.get(ref.name);
      const moduleManifest = module?.manifest || {};
      const terms = [...packTerms, moduleManifest.name, moduleManifest.displayName, moduleManifest.description, ...(moduleManifest.capabilities || [])];
      for (const toolName of Object.keys(moduleManifest.tools || {})) {
        metadata[toolName] = {
          domain: boundedText(pack.display_name || pack.name, 120),
          description: boundedText(pack.description, 300),
          terms: terms.map(term => boundedText(term)).filter(Boolean).slice(0, 24),
        };
      }
    }
  }
  return metadata;
}

module.exports = { discoverCapabilities, buildAgentCapabilityMetadata, boundedText };
