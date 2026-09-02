"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const recipes = require("../src/proving/recipes");

const all = recipes.listRecipes();
const discovered = fs.readdirSync(path.join(__dirname, "..", "packs"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(__dirname, "..", "packs", entry.name, "sidekick.pack.json")));
assert.strictEqual(all.length, discovered.length);
assert.strictEqual(new Set(all.map(recipe => recipe.pack)).size, discovered.length);
for (const recipe of all) {
  assert.strictEqual(recipes.validateRecipe(recipe).valid, true, recipe.id);
  assert.strictEqual(recipe.mutation_policy, "read_only_by_default");
  assert.ok(Array.isArray(recipe.negative_checks));
  assert.ok(Array.isArray(recipe.expected_evidence));
}
assert.strictEqual(recipes.getRecipe("does-not-exist"), null);
console.log("Proving recipe catalog tests passed");
