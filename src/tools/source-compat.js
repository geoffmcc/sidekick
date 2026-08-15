"use strict";

function createSourceCompat({ toolContext }) {
  let compatibilitySource = "unknown";

  function setSource(source) {
    compatibilitySource = source || "unknown";
    toolContext.setExecutionSource(compatibilitySource);
  }

  function getCurrentSource() {
    return toolContext.getExecutionSource() || compatibilitySource || "unknown";
  }

  return { setSource, getCurrentSource };
}

module.exports = { createSourceCompat };
