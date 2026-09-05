"use strict";

const fs = require("fs");
const path = require("path");
const recipeFile = path.resolve(__dirname, "..", "..", "docs", "proving-recipes.json");

function listRecipes() {
  const data = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
  if (data.schema !== "sidekick.pack-proving-recipes.v1" || data.recipe_version !== 1 || !Array.isArray(data.recipes)) throw new Error("invalid proving recipe catalog");
  return data.recipes.map(recipe => ({ ...recipe, single_pack: [...recipe.single_pack], negative_checks: [...recipe.negative_checks] }));
}

function getRecipe(pack) {
  return listRecipes().find(recipe => recipe.pack === String(pack)) || null;
}

function validateRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== "object") return { valid: false, errors: ["recipe is required"] };
  if (recipe.version !== 1 || !/^pack-proving\.[a-z][a-z0-9-]*$/.test(recipe.id || "")) errors.push("recipe identity/version is invalid");
  if (!recipe.pack || recipe.id !== `pack-proving.${recipe.pack}`) errors.push("recipe pack identity is invalid");
  if (!Array.isArray(recipe.preconditions) || !Array.isArray(recipe.expected_evidence)) errors.push("recipe evidence contract is incomplete");
  for (const field of ["discovery", "single_pack", "cross_pack", "negative_checks", "independent_verification"]) {
    if (!Array.isArray(recipe[field])) errors.push(`recipe ${field} must be an array`);
  }
  const cases = Array.isArray(recipe.single_pack) ? recipe.single_pack : [];
  if (cases.length > Number(recipe.bounds?.max_steps || 0)) errors.push("recipe single_pack exceeds its step bound");
  for (const item of cases) {
    if (!item || typeof item !== "object") errors.push("recipe single_pack contains an invalid case");
    else if (item.mutation !== false) errors.push("recipe executable cases must explicitly declare mutation=false");
  }
  if (recipe.mutation_policy !== "read_only_by_default") errors.push("recipe must default to read-only");
  if (!Number.isInteger(recipe.bounds?.timeout_ms) || recipe.bounds.timeout_ms < 100 || recipe.bounds.timeout_ms > 86400000) errors.push("recipe timeout is outside bounds");
  return { valid: errors.length === 0, errors };
}

module.exports = { listRecipes, getRecipe, validateRecipe };
