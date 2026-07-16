let currentSource = "mcp";

function setExecutionSource(source) {
  currentSource = source || "mcp";
}

function getExecutionSource() {
  return currentSource;
}

module.exports = { setExecutionSource, getExecutionSource };
