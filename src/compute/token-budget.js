"use strict";

// Output budgets are deliberately explicit. Prompt-length heuristics are too
// easy to fool and make latency/cost unpredictable; callers can select a tier,
// while an explicit maxTokens value always wins.
const OUTPUT_TOKEN_BUDGETS = Object.freeze({
  normal: 4096,
  complex: 8192,
  large: 16384,
});

function resolveOutputTokenBudget({ maxTokens, outputBudget } = {}) {
  if (maxTokens !== undefined && maxTokens !== null) {
    if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 262144) {
      throw new Error("maxTokens must be an integer between 256 and 262144");
    }
    return maxTokens;
  }
  const tier = outputBudget || "normal";
  if (!Object.prototype.hasOwnProperty.call(OUTPUT_TOKEN_BUDGETS, tier)) {
    throw new Error(`outputBudget must be one of: ${Object.keys(OUTPUT_TOKEN_BUDGETS).join(", ")}`);
  }
  return OUTPUT_TOKEN_BUDGETS[tier];
}

function normalizeOutputBudgetPayload(jobType, payload = {}) {
  if (jobType !== "chat" && jobType !== "generate") return payload;
  if (payload.maxTokens !== undefined) return payload;
  if (payload.outputBudget === undefined) return payload;
  return { ...payload, maxTokens: resolveOutputTokenBudget({ outputBudget: payload.outputBudget }) };
}

module.exports = { OUTPUT_TOKEN_BUDGETS, resolveOutputTokenBudget, normalizeOutputBudgetPayload };
