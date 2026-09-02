"use strict";

const assert = require("assert");
const recipes = require("../src/proving/recipes");

const all = recipes.listRecipes();
assert.strictEqual(all.length, 27);
assert.strictEqual(new Set(all.map(recipe => recipe.pack)).size, 27);
for (const recipe of all) {
  assert.strictEqual(recipes.validateRecipe(recipe).valid, true, recipe.id);
  assert.strictEqual(recipe.mutation_policy, "read_only_by_default");
  assert.ok(Array.isArray(recipe.negative_checks));
  assert.ok(Array.isArray(recipe.expected_evidence));
}
assert.strictEqual(recipes.getRecipe("does-not-exist"), null);
console.log("Proving recipe catalog tests passed");
