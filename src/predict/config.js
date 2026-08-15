/** Predict configuration parsing and normalization. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function getConfig(defaultSequenceGapMinutes) {
  return {
    retention_days: envNonNegativeInt("SIDEKICK_PREDICT_RETENTION_DAYS", 90),
    sequence_gap_minutes: envInt("SIDEKICK_PREDICT_SEQUENCE_GAP_MINUTES", defaultSequenceGapMinutes),
    enable_relevant_context: envBool("SIDEKICK_PREDICT_ENABLE_RELEVANT_CONTEXT", false),
    identity_cooldown_days: envInt("SIDEKICK_PREDICT_IDENTITY_COOLDOWN_DAYS", 7),
  };
}

module.exports = { envInt, envNonNegativeInt, envBool, getConfig };
