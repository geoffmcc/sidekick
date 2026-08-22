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
const OBSERVATION_GOAL_PATTERN = /\b(?:is|are|does|do|has|have|what|which|who)\b[\s\S]{0,100}\b(?:playing|watching|viewing|streaming|running|online|offline|healthy|available|active|connected|working|down|up|idle|busy|open|closed|pending|loaded|mounted|reachable|status|state|sessions?|guests?|vms?|containers?)\b|\b(?:playing|watching|viewing|streaming|running|online|offline|healthy|available|active|connected|working|down|up|idle|busy|open|closed|pending|loaded|mounted|reachable|status|state|sessions?|guests?|vms?|containers?)\b[\s\S]{0,100}\b(?:is|are|does|do|has|have)\b/i;

function observationRiskPenalty(definition, goal) {
  if (!OBSERVATION_GOAL_PATTERN.test(String(goal || ""))) return 0;
  const risk = String(definition.risk || "").toLowerCase();
  return risk === "critical" ? 4 : risk === "high" ? 3 : risk === "medium" ? 1 : 0;
}

function boundedText(value, max = MAX_TEXT) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(?:system|assistant|user|developer)\s*:/gi, match => match.replace(":", " -"))
    .replace(/\s+/g, " ").trim().slice(0, max);
}

function looksLikeFilesystemPath(value) {
  const candidate = String(value || "").trim();
  return candidate.length > 1 && (candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate));
}

function trimPathPunctuation(value) {
  return String(value || "").trim().replace(/[.,;:!?]+$/, "").replace(/[)\]}]+$/, "");
}

/**
 * Extract an explicit filesystem target from a request as generic scope data.
 * This is deliberately capability-agnostic: the provider declares which
 * argument receives the request path, while the broker only recognizes
 * bounded absolute path syntax and never decides which capability to use.
 */
function extractRequestPath(value) {
  const text = boundedText(value, 4000);
  const quoted = /["']([^"']{2,2048})["']/g;
  let match;
  while ((match = quoted.exec(text))) {
    const candidate = trimPathPunctuation(match[1]);
    if (looksLikeFilesystemPath(candidate)) return candidate;
  }
  const bare = /(?:[A-Za-z]:[\\/][^\s"'<>|]+|\/(?:[^\s"'<>|]+\/)*[^\s"'<>|]+)/g;
  while ((match = bare.exec(text))) {
    const candidate = trimPathPunctuation(match[0]);
    if (looksLikeFilesystemPath(candidate)) return candidate;
  }
  return null;
}

function resolveContextProviderArgs(provider, goal, { repositoryPath = null } = {}) {
  const args = { action: provider?.action || "query" };
  const scope = provider?.scope;
  if (!scope || !scope.argument) return args;
  const requestedPath = scope.source === "request_path_or_context"
    ? (extractRequestPath(goal) || (looksLikeFilesystemPath(repositoryPath) ? repositoryPath : null))
    : extractRequestPath(goal);
  if (requestedPath) args[scope.argument] = requestedPath;
  return args;
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
    score -= observationRiskPenalty(def, goal);
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

// Routing may use a declarative context provider to decide that an otherwise
// conceptual request needs live evidence.  This reports only a positive
// metadata match; fallback catalog entries never force inspection.
function hasRelevantContextProvider(goal, definitions, metadata = {}) {
  const query = tokens(goal);
  return (definitions || []).some(definition => {
    if (!definition || definition.enabled === false || !definition.contextProvider) return false;
    const haystack = tokens(capabilityText(definition, metadata));
    return [...query].some(word => [...haystack].some(candidate => overlaps(word, candidate)));
  });
}

function buildAgentCapabilityMetadata({ packs = [], modules = [], workflows = [] } = {}) {
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
  // Registered pack workflows are canonical declarative capability guidance.
  // They may improve discovery by describing the exact read-only action a
  // tool uses, but they never add a tool, grant authority, or carry arbitrary
  // prompt instructions. Only bounded titles, descriptions, tags, tool names,
  // and scalar action labels are copied into the Agent metadata.
  for (const workflow of workflows || []) {
    if (!workflow || workflow.state !== "registered") continue;
    const definition = workflow.definition && typeof workflow.definition === "object" ? workflow.definition : {};
    const shared = [definition.name, definition.title, definition.description, ...(Array.isArray(definition.tags) ? definition.tags : [])]
      .map(value => boundedText(value, 160)).filter(Boolean);
    for (const step of Array.isArray(definition.steps) ? definition.steps : []) {
      if (!step || typeof step.tool !== "string") continue;
      const action = step.args && typeof step.args.action === "string" ? step.args.action : "";
      // Preserve the exact action and step intent before broad pack prose so
      // the bounded metadata budget cannot discard the executable read-only
      // contract that the planner needs.
      const terms = [action, step.title, step.name, ...shared]
        .map(value => boundedText(value, 160)).filter(Boolean);
      if (!metadata[step.tool]) metadata[step.tool] = { domain: "", description: "", terms: [] };
      const entry = metadata[step.tool];
      entry.actions = [...new Set([...(entry.actions || []), ...(action ? [action] : [])])].slice(0, 64);
      entry.actionHints = [...(entry.actionHints || [])];
      if (action) {
        const hint = boundedText([`action=${action}`, `intent=${step.title || step.name || ""}`, ...shared].filter(Boolean).join("; "), 240);
        if (hint && !entry.actionHints.includes(hint)) entry.actionHints.push(hint);
        entry.actionHints = entry.actionHints.slice(0, 64);
      }
      // Keep executable action labels ahead of broad pack prose. The prompt
      // is intentionally bounded, but a relevant registered action must not
      // disappear merely because an earlier workflow contributed descriptions
      // and tags first.
      entry.terms = [...new Set([
        ...(entry.actions || []),
        ...(entry.terms || []),
      ])].slice(0, 32);
      if (!entry.description && definition.description) entry.description = boundedText(definition.description, 300);
    }
  }
  return metadata;
}

module.exports = { discoverCapabilities, hasRelevantContextProvider, buildAgentCapabilityMetadata, boundedText, extractRequestPath, resolveContextProviderArgs };
