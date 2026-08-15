const MIN_OBSERVATIONS_FOR_PREDICTION = 3;
const MIN_OBSERVATIONS_FOR_HIGH_CONFIDENCE = 15;
const MIN_OBSERVATIONS_FOR_VERY_HIGH_CONFIDENCE = 30;

function smoothScore(score, sampleSize, prior) {
  prior = prior || 0.5;
  const alpha = 2;
  const beta = 2;
  return (prior * alpha + score * sampleSize) / (alpha + beta + sampleSize);
}

function calculateBaseRate(matchCount, totalCount) {
  if (totalCount === 0) return 0;
  return matchCount / totalCount;
}

function applyProjectAdjustment(baseRate, sameProject) {
  if (sameProject) return Math.min(baseRate + 0.08, 1.0);
  return baseRate;
}

function applyRecencyAdjustment(baseRate, recentMatches, totalMatches) {
  if (totalMatches === 0) return baseRate;
  const recencyRatio = recentMatches / totalMatches;
  return Math.min(baseRate + recencyRatio * 0.06, 1.0);
}

function applyContradictionPenalty(baseRate, contradictionCount, totalMatches) {
  if (contradictionCount === 0) return baseRate;
  const penalty = (contradictionCount / Math.max(totalMatches, 1)) * 0.15;
  return Math.max(baseRate - penalty, 0.0);
}

function calculateConfidence(score, sampleSize) {
  if (sampleSize >= MIN_OBSERVATIONS_FOR_VERY_HIGH_CONFIDENCE && score >= 0.8) return "very_high";
  if (sampleSize >= MIN_OBSERVATIONS_FOR_HIGH_CONFIDENCE && score >= 0.7) return "high";
  if (sampleSize >= MIN_OBSERVATIONS_FOR_PREDICTION && score >= 0.4) return "medium";
  if (sampleSize >= 1) return "low";
  return "none";
}

function calculateScore(params) {
  let score = params.baseRate || 0;
  score = applyProjectAdjustment(score, params.sameProject);
  score = applyRecencyAdjustment(score, params.recentMatches || 0, params.totalMatches || 0);
  score = applyContradictionPenalty(score, params.contradictions || 0, params.totalMatches || 0);
  score = smoothScore(score, params.sampleSize || 0, 0.5);
  const confidence = params.confidence || calculateConfidence(score, params.sampleSize || 0);
  return {
    probability: Math.round(score * 1000) / 1000,
    confidence,
    breakdown: {
      base_rate: Math.round((params.baseRate || 0) * 1000) / 1000,
      same_project: !!params.sameProject,
      recent_matches: params.recentMatches || 0,
      total_matches: params.totalMatches || 0,
      contradictions: params.contradictions || 0,
      sample_size: params.sampleSize || 0,
      smoothed: Math.round(score * 1000) / 1000
    }
  };
}

module.exports = {
  smoothScore,
  calculateBaseRate,
  applyProjectAdjustment,
  applyRecencyAdjustment,
  applyContradictionPenalty,
  calculateConfidence,
  calculateScore,
  MIN_OBSERVATIONS_FOR_PREDICTION,
  MIN_OBSERVATIONS_FOR_HIGH_CONFIDENCE,
  MIN_OBSERVATIONS_FOR_VERY_HIGH_CONFIDENCE,
};
