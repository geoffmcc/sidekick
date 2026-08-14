"use strict";

const path = require("path");

function requireSidekickSrc(relativePath) {
  let directory = __dirname;
  for (let index = 0; index < 8; index += 1) {
    const candidate = path.join(directory, relativePath);
    try {
      return require(candidate);
    } catch (error) {
      if (
        error.code !== "MODULE_NOT_FOUND" ||
        !error.message.includes(candidate)
      ) {
        throw error;
      }
    }
    directory = path.dirname(directory);
  }
  return require(path.join(process.cwd(), relativePath));
}

function requireFromSidekick(name) {
  return require(name);
}

module.exports = { requireSidekickSrc, requireFromSidekick };
