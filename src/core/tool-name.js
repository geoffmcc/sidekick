"use strict";

const SIDEKICK_PREFIX = "sidekick_";

function stripSidekickPrefix(name) {
  if (typeof name === "string" && name.startsWith(SIDEKICK_PREFIX)) {
    return name.slice(SIDEKICK_PREFIX.length);
  }
  return name;
}

function addSidekickPrefix(name) {
  if (typeof name === "string" && !name.startsWith(SIDEKICK_PREFIX)) {
    return SIDEKICK_PREFIX + name;
  }
  return name;
}

function toMcpName(canonicalName) {
  return stripSidekickPrefix(canonicalName);
}

function toCanonical(internalName) {
  if (typeof internalName !== "string") return internalName;
  if (internalName.startsWith(SIDEKICK_PREFIX)) return internalName;
  return SIDEKICK_PREFIX + internalName;
}

function isSidekickPrefixed(name) {
  return typeof name === "string" && name.startsWith(SIDEKICK_PREFIX);
}

function isValidCanonicalToolName(name) {
  return typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(stripSidekickPrefix(name));
}

module.exports = {
  SIDEKICK_PREFIX,
  stripSidekickPrefix,
  addSidekickPrefix,
  toMcpName,
  toCanonical,
  isSidekickPrefixed,
  isValidCanonicalToolName,
};
