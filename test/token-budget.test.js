"use strict";

const assert = require("assert");
const {
  OUTPUT_TOKEN_BUDGETS,
  resolveOutputTokenBudget,
  normalizeOutputBudgetPayload,
} = require("../src/compute/token-budget");

assert.deepStrictEqual(OUTPUT_TOKEN_BUDGETS, { normal: 4096, complex: 8192, large: 16384 });
assert.strictEqual(resolveOutputTokenBudget({ outputBudget: "normal" }), 4096);
assert.strictEqual(resolveOutputTokenBudget({ outputBudget: "complex" }), 8192);
assert.strictEqual(resolveOutputTokenBudget({ outputBudget: "large" }), 16384);
assert.strictEqual(resolveOutputTokenBudget({ outputBudget: "complex", maxTokens: 12000 }), 12000);
assert.strictEqual(resolveOutputTokenBudget({}), 4096);
assert.deepStrictEqual(
  normalizeOutputBudgetPayload("chat", { prompt: "x", outputBudget: "complex" }),
  { prompt: "x", outputBudget: "complex", maxTokens: 8192 },
);
assert.deepStrictEqual(
  normalizeOutputBudgetPayload("chat", { prompt: "x", outputBudget: "large", maxTokens: 5000 }),
  { prompt: "x", outputBudget: "large", maxTokens: 5000 },
);
assert.deepStrictEqual(
  normalizeOutputBudgetPayload("embeddings", { input: "x", outputBudget: "large" }),
  { input: "x", outputBudget: "large" },
);
assert.throws(() => resolveOutputTokenBudget({ outputBudget: "huge" }), /outputBudget must be one of/);
assert.throws(() => resolveOutputTokenBudget({ maxTokens: 128 }), /maxTokens must be/);

console.log("Token budget tests passed (10 assertions)");
