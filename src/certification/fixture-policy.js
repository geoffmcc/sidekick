"use strict";

const { scenarios } = require("./scenarios");
const { stripSidekickPrefix } = require("../core/tool-name");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const FIXTURE_OPERATIONS = Object.freeze(scenarios
  .filter(scenario => scenario.mode === "hermetic" && scenario.cleanup.external_mutation !== true)
  .flatMap(scenario => (scenario.fixture || []).map(step => Object.freeze({
    tool: stripSidekickPrefix(step.name),
    args: canonicalJson(step.args || {}),
  }))));

function isBoundedCertificationFixtureOperation(toolName, args) {
  if (!toolName || !args || typeof args !== "object" || Array.isArray(args)) return false;
  const tool = stripSidekickPrefix(String(toolName));
  const encoded = canonicalJson(args);
  const descriptor = require("../tools/dispatcher").getBuiltinRegistry().get(tool);
  if (!descriptor) return false;
  return FIXTURE_OPERATIONS.some(operation => {
    if (operation.tool !== tool) return false;
    const expected = descriptor.schema.safeParse(JSON.parse(operation.args));
    return expected.success && canonicalJson(expected.data) === encoded;
  });
}

module.exports = Object.freeze({ isBoundedCertificationFixtureOperation });
