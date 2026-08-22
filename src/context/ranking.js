"use strict";

const AUTHORITY = Object.freeze({
  live: 1,
  verified: 0.95,
  user: 0.92,
  confirmed: 0.88,
  curated: 0.84,
  handoff: 0.7,
  derived: 0.52,
  observation: 0.42,
  historical: 0.3,
});

const SOURCE_PRIORITY = Object.freeze({
  evidence: 1,
  artifact: 0.96,
  knowledge: 0.9,
  handoff: 0.84,
  session: 0.78,
  memory: 0.74,
  relationship: 0.68,
  entity: 0.64,
  legacy_context: 0.55,
  repository_semantic: 0.82,
});

function tokens(value) {
  return new Set(String(value || "").toLowerCase().split(/[^a-z0-9_]+/).filter(token => token.length > 2));
}

function lexicalScore(query, text) {
  const wanted = tokens(query);
  if (!wanted.size) return 0;
  const actual = tokens(text);
  let hits = 0;
  for (const token of wanted) if (actual.has(token)) hits++;
  return hits / wanted.size;
}

function freshnessScore(item, now = Date.now()) {
  const timestamp = item.updatedAt || item.observedAt || item.createdAt || item.date;
  if (!timestamp) return 0.45;
  const ageDays = Math.max(0, (now - new Date(timestamp).getTime()) / 86400000);
  return Math.max(0.05, Math.exp(-ageDays / 180));
}

function authorityScore(item) {
  if (item.authorityScore != null) return Math.max(0, Math.min(1, Number(item.authorityScore)));
  const source = String(item.authority || item.source || "derived").toLowerCase();
  if (AUTHORITY[source] != null) return AUTHORITY[source];
  const numeric = Number(item.sourceAuthority);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric / 10)) : AUTHORITY.derived;
}

function requiresLiveValidation(query, item, now = Date.now()) {
  const currentQuestion = /\b(current|currently|now|today|running|health|status|version|installed|live|actual|present)\b/i.test(String(query || ""));
  const revalidateAt = item.revalidateAfter && new Date(item.revalidateAfter).getTime();
  const stale = revalidateAt && revalidateAt <= now;
  return !!(item.liveValidationRequired || stale || (currentQuestion && item.source !== "evidence" && item.source !== "live"));
}

function rankEntry(query, item, now = Date.now()) {
  const relevance = Math.max(Number(item.semanticScore) || 0, lexicalScore(query, item.searchText));
  const authority = authorityScore(item);
  const freshness = freshnessScore(item, now);
  const source = SOURCE_PRIORITY[item.source] || 0.5;
  const confidence = Math.max(0, Math.min(1, Number(item.confidence == null ? 0.5 : item.confidence)));
  const validation = requiresLiveValidation(query, item, now);
  const score = relevance * 0.52 + authority * 0.2 + confidence * 0.15 + freshness * 0.08 + source * 0.05;
  const reasons = [];
  if (relevance > 0) reasons.push("QUERY_MATCH");
  if (item.project) reasons.push("PROJECT_SCOPE_MATCH");
  if (authority >= 0.84) reasons.push("HIGH_AUTHORITY");
  if (validation) reasons.push("STALE_REQUIRES_VALIDATION");
  if (item.superseded) reasons.push("SUPERSEDED_EXCLUDED");
  return { ...item, score, relevance, authorityScore: authority, freshnessScore: freshness, liveValidationRequired: validation, reasonCodes: reasons };
}

module.exports = Object.freeze({ lexicalScore, freshnessScore, authorityScore, requiresLiveValidation, rankEntry });
